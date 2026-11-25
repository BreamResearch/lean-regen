#!/usr/bin/env python3
"""Exercise PostgreSQL in a new, private Unix-socket cluster. No dependency beyond Python and PostgreSQL."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import time

HERE = Path(__file__).resolve().parent
ADMIN = "knot_admin"
ROLES = (ADMIN, "north_writer", "north_peer", "north_reader", "south_writer")


def check(condition, message):
    if not condition:
        raise RuntimeError(message)


class Cluster:
    def __init__(self, bindir, folder):
        self.bin = bindir
        self.root = folder
        self.db = folder / "db"
        self.sock = folder / "socket"
        self.sock.mkdir(mode=0o700)
        self.passwords = {role: secrets.token_hex(32) for role in ROLES}
        self.env = {k:v for k,v in os.environ.items() if not k.startswith("PG")}
        self.env.update(LC_ALL="C", PGHOST=str(self.sock), PGPORT="55432", PGDATABASE="postgres",
                        PGPASSFILE=str(folder/"pgpass"), PGCONNECT_TIMEOUT="4")
        self.private_file("pgpass", "".join(f"*:*:postgres:{r}:{s}\n" for r,s in self.passwords.items()))
        self.private_file("initial-password", self.passwords[ADMIN] + "\n")

    def private_file(self, name, contents):
        fd = os.open(self.root/name, os.O_CREAT|os.O_WRONLY|os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(contents)

    def command(self, name, *args):
        p = subprocess.run([str(self.bin/name), *map(str,args)], env=self.env, capture_output=True, text=True, timeout=50)
        check(p.returncode==0, name+" failed: "+(p.stderr or p.stdout)[-1000:])
        return p.stdout

    def __enter__(self):
        self.command("initdb","-D",self.db,"-U",ADMIN,"--encoding=UTF8","--locale=C",
                     "--auth-local=scram-sha-256","--auth-host=reject","--pwfile",self.root/"initial-password")
        options = f"-c listen_addresses='' -c unix_socket_directories={self.sock} -c unix_socket_permissions=0700 -p 55432"
        self.command("pg_ctl","-D",self.db,"-l",self.root/"postgres.log","-w","start","-o",options)
        return self

    def __exit__(self,*_):
        self.command("pg_ctl","-D",self.db,"-m","immediate","-w","stop")

    def client(self, role, label):
        return [str(self.bin/"psql"), "-X", "-w", "-qAt", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-U",role],dict(self.env,PGAPPNAME=label)

    def query(self, sql, role=ADMIN, label="knot-observer", denied=False, extra_env=None):
        cmd,env=self.client(role,label)
        r=subprocess.run(cmd,input=sql,env={**env,**(extra_env or {})},text=True,capture_output=True,timeout=12)
        if denied:
            check(r.returncode!=0 and "42501" in r.stderr, f"Expected permission_denied, got {r.stdout} {r.stderr}")
            return "42501"
        check(r.returncode==0, "PostgreSQL request failed: "+r.stderr[-900:])
        return r.stdout.strip()

    def start_query(self, sql, role, label):
        cmd,env=self.client(role,label)
        p=subprocess.Popen(cmd,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env,text=True)
        p.stdin.write(sql+"\n")
        p.stdin.flush()
        return p

    def await_activity(self, sql):
        deadline=time.monotonic()+7
        while time.monotonic()<deadline:
            x=self.query(sql)
            if x:
                return x
            time.sleep(.035)
        raise RuntimeError("Expected live PostgreSQL activity was not observed")

    @staticmethod
    def end(p, extra=""):
        out,err=p.communicate(input=extra,timeout=9)
        check(p.returncode==0, "Client failed: "+err[-700:])
        return out.strip()

    def held(self, sql, role, name):
        p=self.start_query("BEGIN; "+sql+"; SELECT 'holding';",role,name)
        try:
            pid=int(self.await_activity(f"SELECT pid FROM pg_stat_activity WHERE application_name='{name}' AND state='idle in transaction' AND query LIKE '%holding%';"))
            return p,pid
        except BaseException:
            p.kill(); p.communicate(); raise

    def blocked_then_release(self, held, holder_pid, name, sql, role):
        follower=self.start_query(sql+";",role,name)
        try:
            pid=int(self.await_activity(f"SELECT pid FROM pg_stat_activity WHERE application_name='{name}' AND {holder_pid}=ANY(pg_blocking_pids(pid));"))
            check(pid!=holder_pid,"Expected distinct PostgreSQL backends")
            result1=self.end(held,"COMMIT;\n")
            result2=self.end(follower)
            return {"holder_pid":holder_pid,"waiting_pid":pid,"blocker_observed":True,
                    "holder_result":result1.splitlines()[0],"waiter_result":result2}
        finally:
            for p in (held,follower):
                if p.poll() is None:
                    p.kill(); p.communicate()


def post(v,tenant,name,revision,budget,hours):
    # All literals are program-controlled, with no external SQL input.
    return f"SELECT knot_api.post_v{v}('{tenant}','{name}',{revision},{budget},{hours})"


def sql_rows(c, table, order):
    return json.loads(c.query(f"SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY {order}),'[]') FROM knot_store.{table} r;"))


def witness(c):
    journal=sql_rows(c,"journal","r.tenant,r.revision")
    heads=sql_rows(c,"head","r.tenant")
    opening=sql_rows(c,"opening","r.tenant,r.pool")
    expected={(r["tenant"],r["pool"]):[r["budget"],r["hours"]] for r in opening}
    rev={r["tenant"]:1 for r in opening}
    for row in journal:
        tenant=row["tenant"]
        rev[tenant]+=1
        check(row["revision"]==rev[tenant],"Missing or duplicated journal revision")
        for pool,sign in (("A",-1),("B",1)):
            balance=expected[tenant,pool]
            balance[0]+=sign*row["budget"]
            balance[1]+=sign*row["hours"]
    check(rev=={r["tenant"]:r["revision"] for r in heads},"Journal and revision disagree")
    balances={}
    for (tenant,pool),amounts in expected.items():
        raw=c.query(f"SELECT knot_api.balance('{tenant}','{pool}');",tenant+"_writer")
        balances[tenant+"/"+pool]=[int(x) for x in raw.split(",")]
        check(balances[tenant+"/"+pool]==amounts, "Opening balance + journal mismatch")
    return {"journal":journal,"revisions":rev,"balances":balances}


def exercise(c):
    info=c.query("SELECT current_setting('server_version')||'/'||current_setting('server_version_num');").split("/")
    check(int(info[1])//10000==16,"Use PostgreSQL 16.x")
    c.query((HERE/"ledger.sql").read_text())
    c.query("\n".join(f"ALTER ROLE {role} PASSWORD '{c.passwords[role]}';" for role in ROLES if role!=ADMIN))
    check(c.query("SELECT count(*) FROM pg_roles WHERE rolname IN ('north_writer','north_peer','north_reader','south_writer') AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls);")=="0","Overprivileged test login")
    cmd, public_env = c.client("north_writer","invalid-login-check")
    public_env["PGPASSWORD"] = secrets.token_hex(32)
    unauthorized = subprocess.run(cmd, input="SELECT 1;", env=public_env, capture_output=True, text=True, timeout=5)
    check(unauthorized.returncode != 0 and "password authentication failed" in unauthorized.stderr,
          "A wrong ephemeral password did not fail authentication")
    initial=witness(c)
    denials={
      "reader_cannot_post":c.query(post(1,"north","reader",1,20,10),"north_reader",denied=True),
      "writer_cannot_read_other_tenant":c.query("SELECT knot_api.balance('south','A');","north_writer",denied=True),
      "writer_cannot_post_other_tenant":c.query(post(1,"south","wrong-scope",1,20,10),"north_writer",denied=True),
      "reader_cannot_select_private_table":c.query("SELECT * FROM knot_store.journal;","north_reader",denied=True),
      "writer_cannot_update_private_balances":c.query("UPDATE knot_store.wide SET hours=hours WHERE false;","north_writer",denied=True),
    }
    check(c.query("SELECT knot_api.balance('north','A');","north_reader")=="1000,400","Own-scope read failed")
    check(witness(c)==initial,"Authorization failure changed the database")

    held,pid=c.held(post(1,"north","race-winner",1,70,25),"north_writer","race-holder")
    race=c.blocked_then_release(held,pid,"race-contender",post(1,"north","race-other",1,60,20),"north_peer")
    check((race["holder_result"],race["waiter_result"])==("committed","stale"),"Race did not serialize")
    after_race=witness(c)
    check(len(after_race["journal"])==1,"Multiple winning writers")
    check(c.query(post(1,"north","race-winner",1,70,25),"north_writer")=="duplicate","Retry duplicated")
    check(c.query(post(1,"north","race-winner",1,71,25),"north_writer")=="id-conflict","Payload collision accepted")
    check(witness(c)==after_race,"Replay changed committed state")

    c.query((HERE/"expand.sql").read_text())
    early=c.query("SELECT knot_store.contract();")
    check(early=="unreconciled","Early cutover accepted")
    c.query("SELECT knot_store.backfill('north');")
    check(c.query("SELECT knot_store.contract();")=="unreconciled","Partial backfill accepted")
    old,pid=c.held(post(1,"north","legacy-during-expand",2,35,10),"north_peer","old-writer")
    new=c.query("SELECT pg_backend_pid(); "+post(2,"south","modern-during-expand",1,45,15)+";","south_writer","new-writer").splitlines()
    check(int(new[0])!=pid and new[1]=="committed","Independent new client did not commit")
    # North is still uncommitted while the new writer's committed south entry is visible.
    check(c.query("SELECT string_agg(revision::text,',' ORDER BY tenant) FROM knot_store.head;")=="2,2","Concurrent write visibility mismatch")
    overlap=c.blocked_then_release(old,pid,"backfill", "SELECT knot_store.backfill('north'); SELECT 'backfilled'",ADMIN)
    check(overlap["holder_result"]=="committed" and overlap["waiter_result"]=="backfilled","Backfill/writer ordering failed")
    before_cutover=witness(c)
    # Deliberately offset one copied value inside a transaction; discard the test fixture afterwards.
    mismatch=c.query("BEGIN; UPDATE knot_store.amount SET amount=amount+1 WHERE tenant='north' AND pool='A' AND unit='hours'; SELECT knot_store.contract(); ROLLBACK;")
    check(mismatch=="unreconciled","Divergent copied row passed cutover")
    check(witness(c)==before_cutover,"Reconciliation challenge leaked a change")

    old,pid=c.held(post(1,"north","legacy-at-cutover",3,10,5),"north_writer","cutover-holder")
    gate=c.blocked_then_release(old,pid,"cutover","SELECT knot_store.contract()",ADMIN)
    check((gate["holder_result"],gate["waiter_result"])==("committed","contracted"),"Cutover failed")
    check(c.query("SELECT to_regclass('knot_store.wide') IS NULL;")=="t","Old table still present")
    contracted=witness(c)
    check(c.query(post(1,"north","obsolete",4,5,2),"north_writer")=="writer-retired","Old writer crossed cutover")
    check(witness(c)==contracted,"Retired writer altered state")
    check(c.query(post(2,"north","v2-only",4,30,12),"north_writer")=="committed","v2-only write failed")
    final=witness(c)
    check(final["revisions"]=={"north":5,"south":2} and len(final["journal"])==5,"Unexpected final history")
    check(final["balances"]=={"north/A":[855,348],"north/B":[445,202],"south/A":[755,285],"south/B":[245,115]},"Unexpected final balances")
    return {"status":"PASS","server_version":info[0],"client":c.command("psql","--version").strip(),
            "authentication":"SCRAM-SHA-256 over a private Unix socket; fresh passwords per run",
            "wrong_password_rejected":True,"denials_sqlstate":denials,"race":race,"after_race":after_race,"early_cutover":early,
            "dual_write":{"new_writer_pid":int(new[0]),"new_committed_while_old_was_open":True,"backfill":overlap},
            "mismatched_copy_cutover":mismatch,"before_cutover":before_cutover,"cutover":gate,"v1_table_removed":True,"retired_writer":"writer-retired",
            "final":final,"sources":{p:hashlib.sha256((HERE/p).read_bytes()).hexdigest() for p in ("ledger.sql","expand.sql","verify.py")}}


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--pg-bin",required=True,type=Path)
    p.add_argument("--out",required=True,type=Path,help="A new JSON report path")
    args=p.parse_args()
    check(not args.out.exists(),"Choose a new report path")
    with tempfile.TemporaryDirectory(prefix="knotpg-",dir="/tmp") as folder:
        with Cluster(args.pg_bin.resolve(),Path(folder)) as c:
            result=exercise(c)
    with args.out.open("x",encoding="utf-8") as f:
        json.dump(result,f,indent=2); f.write("\n")
    print(f"PostgreSQL {result['server_version']} passed race, permissions, dual-write/backfill and guarded cutover. {args.out}")

if __name__=="__main__":
    main()
