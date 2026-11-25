#!/usr/bin/env python3
"""Start pinned Odoo/PostgreSQL containers for one benchmark command, then remove them."""

import argparse
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import time
from xmlrpc.client import ServerProxy

HERE = Path(__file__).resolve().parent
PINS = json.loads((HERE / "images.json").read_text())
ROTATE = """import os
admin = env.ref('base.user_admin')
admin.write({'password': os.environ['KNOT_ODOO_PASSWORD']})
env['ir.config_parameter'].sudo().set_param('knotbench.fresh_db', env.cr.dbname)
env.cr.commit()
"""


class Appliance:
    def __init__(self):
        self.db = "knotbench_" + secrets.token_hex(6)
        self.network = self.db + "-net"
        self.postgres = self.db + "-pg"
        self.odoo = self.db + "-odoo"
        self.volume = self.db + "-files"
        self.images = {k: v["repository"] + "@" + v["digest"] for k, v in PINS.items()}
        self.env = dict(
            os.environ,
            POSTGRES_DB=self.db,
            POSTGRES_USER="knot_setup",
            POSTGRES_PASSWORD=secrets.token_hex(32),
            USER="knot_odoo",
            HOST="db",
            PORT="5432",
            PASSWORD=secrets.token_hex(32),
            KNOT_ODOO_PASSWORD=secrets.token_hex(32),
        )
        self.cleanup = []

    def docker(self, *args, data=None, check=True, timeout=600):
        result = subprocess.run(
            ["docker", *args],
            env=self.env,
            text=True,
            input=data,
            capture_output=True,
            timeout=timeout,
        )
        if check and result.returncode:
            msg = (result.stderr or result.stdout or "Docker command failed")[-2000:]
            for name in ("POSTGRES_PASSWORD", "PASSWORD", "KNOT_ODOO_PASSWORD"):
                msg = msg.replace(self.env[name], "[redacted]")
            raise RuntimeError(msg)
        return result

    def ready(self):
        for image in self.images.values():
            self.docker("pull", image)
        self.docker("network", "create", self.network)
        self.cleanup.append(("network", "rm", self.network))
        self.docker("volume", "create", self.volume)
        self.cleanup.append(("volume", "rm", self.volume))
        self.cleanup.append(("rm", "-fv", self.postgres))
        self.docker(
            "run",
            "-d",
            "--name",
            self.postgres,
            "--network",
            self.network,
            "--network-alias",
            "db",
            "-p",
            "127.0.0.1::5432",
            "-e",
            "POSTGRES_USER",
            "-e",
            "POSTGRES_PASSWORD",
            "-e",
            "POSTGRES_DB",
            self.images["postgres"],
        )
        for _ in range(100):
            result = self.docker(
                "exec",
                self.postgres,
                "pg_isready",
                "-h",
                "127.0.0.1",
                "-U",
                self.env["POSTGRES_USER"],
                "-d",
                self.db,
                check=False,
            )
            if result.returncode == 0:
                break
            time.sleep(0.5)
        else:
            raise RuntimeError("PostgreSQL did not start")
        # Password and database name are internally generated hex/identifier literals.
        role_sql = (
            f"CREATE ROLE knot_odoo LOGIN PASSWORD '{self.env['PASSWORD']}';\n"
            f"ALTER DATABASE {self.db} OWNER TO knot_odoo;\n"
            "CREATE EXTENSION IF NOT EXISTS unaccent;\n"
            "CREATE EXTENSION IF NOT EXISTS pg_trgm;\n"
        )
        self.docker(
            "exec",
            "-i",
            self.postgres,
            "psql",
            "-v",
            "ON_ERROR_STOP=1",
            "-U",
            self.env["POSTGRES_USER"],
            "-d",
            self.db,
            data=role_sql,
        )
        common = [
            "--network",
            self.network,
            "-v",
            self.volume + ":/var/lib/odoo",
            "-e",
            "USER",
            "-e",
            "HOST",
            "-e",
            "PORT",
            "-e",
            "PASSWORD",
        ]
        limits = [
            "--workers=0",
            "--max-cron-threads=0",
            "--limit-time-cpu=300",
            "--limit-time-real=600",
        ]
        init = self.db + "-init"
        self.cleanup.append(("rm", "-fv", init))
        self.docker(
            "run",
            "--rm",
            "--name",
            init,
            *common,
            self.images["odoo"],
            "odoo",
            "-d",
            self.db,
            "-i",
            "project",
            "--without-demo=all",
            "--stop-after-init",
            "--no-http",
            *limits,
        )
        self.docker(
            "run",
            "--rm",
            "-i",
            "--name",
            init,
            *common,
            "-e",
            "KNOT_ODOO_PASSWORD",
            self.images["odoo"],
            "odoo",
            "shell",
            "-d",
            self.db,
            "--no-http",
            *limits,
            data=ROTATE,
        )
        self.cleanup.append(("rm", "-fv", self.odoo))
        self.docker(
            "run",
            "-d",
            "--name",
            self.odoo,
            *common,
            "-p",
            "127.0.0.1::8069",
            self.images["odoo"],
            "odoo",
            "-d",
            self.db,
            "--db-filter=^" + self.db + "$",
            "--no-database-list",
            *limits,
        )

        def host_port(name, port):
            portmap = self.docker("port", name, str(port) + "/tcp").stdout.strip()
            match = re.fullmatch(r"127\.0\.0\.1:(\d+)", portmap)
            if not match:
                raise RuntimeError("Unexpected Docker port mapping")
            return match[1]

        url = "http://127.0.0.1:" + host_port(self.odoo, 8069)
        for _ in range(120):
            try:
                with ServerProxy(url + "/xmlrpc/2/common") as remote:
                    if remote.version()["server_version_info"][0] == 18:
                        break
            except (OSError, ConnectionError):
                pass
            time.sleep(0.5)
        else:
            raise RuntimeError("Odoo's XML-RPC endpoint did not become ready")
        host = self.docker(
            "info",
            "--format",
            "{{.NCPU}} {{.MemTotal}} {{.Architecture}} {{.ServerVersion}}",
        ).stdout.split()
        package = self.docker(
            "exec", self.odoo, "dpkg-query", "-W", "-f=${Version}", "odoo"
        ).stdout.strip()
        runtime = {
            "mode": "official-docker",
            "images": PINS,
            "odooPackage": package,
            "odooWorkers": 0,
            "odooCronThreads": 0,
            "httpMode": "threaded",
            "dockerHost": {
                "cpus": int(host[0]),
                "memoryBytes": int(host[1]),
                "architecture": host[2],
                "engineVersion": host[3],
            },
        }
        return dict(
            os.environ,
            KNOT_ODOO_URL=url,
            KNOT_ODOO_DB=self.db,
            KNOT_ODOO_LOGIN="admin",
            KNOT_ODOO_PASSWORD=self.env["KNOT_ODOO_PASSWORD"],
            PGHOST="127.0.0.1",
            PGPORT=host_port(self.postgres, 5432),
            PGDATABASE=self.db,
            PGUSER=self.env["POSTGRES_USER"],
            PGPASSWORD=self.env["POSTGRES_PASSWORD"],
            KNOT_ERP_IMAGES=json.dumps(runtime, separators=(",", ":")),
        )

    def close(self):
        for args in reversed(self.cleanup):
            self.docker(*args, check=False, timeout=50)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("command", nargs=argparse.REMAINDER, help="-- COMMAND [ARGS]")
    options = p.parse_args()
    cmd = options.command
    if cmd and cmd[0] == "--":
        cmd = cmd[1:]
    if not cmd:
        p.error("Provide the benchmark command after --")
    if not shutil.which("docker"):
        p.error("The Docker CLI and a local Docker Engine are required")
    appliance = Appliance()
    try:
        env = appliance.ready()
        return subprocess.run(cmd, env=env).returncode
    finally:
        appliance.close()


if __name__ == "__main__":
    sys.exit(main())
