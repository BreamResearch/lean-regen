#!/usr/bin/env python3
"""Launch the pinned Odoo appliance with access to this run's disposable database clones."""

import argparse
import subprocess
import sys

from erp.run import Appliance


class CloneAppliance(Appliance):
    def docker(self, *args, **kwargs):
        launch_filter = "--db-filter=^" + self.db + "$"
        if launch_filter in args:
            args = list(args)
            index = args.index(launch_filter)
            if args[index - 2 : index] != ["-d", self.db]:
                raise RuntimeError("Unexpected steady Odoo HTTP command")
            args[index - 2 : index + 1] = [
                "--db-filter=^" + self.db[:-4] + "[0-9a-f]{4}$"
            ]
        return super().docker(*args, **kwargs)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args().command
    if args[:1] == ["--"]:
        args = args[1:]
    if not args:
        parser.error("Provide a benchmark command after --")
    appliance = CloneAppliance()
    try:
        env = appliance.ready()
        return subprocess.run(args, env=env).returncode
    finally:
        appliance.close()


if __name__ == "__main__":
    sys.exit(main())
