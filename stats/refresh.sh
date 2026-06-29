#!/usr/bin/env bash
# Regenerate stats/snapshot.json (current point-in-time metrics) and append a
# dated record to stats/history.jsonl so trends can be tracked over time.
#
# Captures both the public GitHub totals (stars / forks / watchers / summed
# release downloads) and the auth-gated metrics the static dashboard can't
# fetch client-side (Cloudflare Pages visits, GitHub repo traffic).
#
# History is one JSON object per line, max one point per calendar day — a
# same-day re-run replaces that day's record rather than piling up.
#
# Usage: stats/refresh.sh
# Requires: gh (authed), the wrangler OAuth token on this machine, python3.
set -euo pipefail
cd "$(dirname "$0")"

ACCT=c6091606631a9ad876e80a70ab5ccd8d
BND_TAG=551a461c62a040b8b9b086e5cc2c3782   # eplus-bnd-viz.pages.dev web-analytics site
WRANGLER_CFG="$HOME/.config/.wrangler/config/default.toml"
GQL=https://api.cloudflare.com/client/v4/graphql

TOKEN=$(grep -E '^oauth_token' "$WRANGLER_CFG" | sed 's/.*= *//;s/"//g')
SINCE=$(date -u -d '30 days ago' +%FT00:00:00Z)
UNTIL=$(date -u +%FT%TZ)
NOW=$(date -u +%FT%TZ)

gh_traffic () { gh api "repos/michaelsweeney/$1/traffic/$2" --jq '"\(.count) \(.uniques)"' 2>/dev/null || echo "0 0"; }
gh_meta ()    { gh api "repos/michaelsweeney/$1" --jq '"\(.stargazers_count) \(.forks_count) \(.subscribers_count)"' 2>/dev/null || echo "0 0 0"; }
gh_downloads(){ gh api "repos/michaelsweeney/$1/releases" --paginate \
                 --jq '[.[].assets[]? | select(.name|test("\\.(yml|blockmap)$")|not) | .download_count] | add // 0' 2>/dev/null || echo 0; }

read -r TS_STARS TS_FORKS TS_WATCH   < <(gh_meta timestep)
read -r BND_STARS BND_FORKS BND_WATCH< <(gh_meta eplus-bnd-branch-visualizer)
TS_DL=$(gh_downloads timestep);  BND_DL=$(gh_downloads eplus-bnd-branch-visualizer)
read -r TS_VIEWS TS_VU   < <(gh_traffic timestep views)
read -r TS_CLONES TS_CU  < <(gh_traffic timestep clones)
read -r BND_VIEWS BND_VU < <(gh_traffic eplus-bnd-branch-visualizer views)
read -r BND_CLONES BND_CU< <(gh_traffic eplus-bnd-branch-visualizer clones)

cf_query () {
  cat <<EOF | curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data @- "$GQL"
{"query":"query(\$a:String!,\$s:Time!,\$u:Time!,\$t:String!){viewer{accounts(filter:{accountTag:\$a}){tot:rumPageloadEventsAdaptiveGroups(limit:1,filter:{datetime_geq:\$s,datetime_leq:\$u,siteTag:\$t}){count sum{visits}} daily:rumPageloadEventsAdaptiveGroups(limit:100,orderBy:[date_ASC],filter:{datetime_geq:\$s,datetime_leq:\$u,siteTag:\$t}){count sum{visits} dimensions{date}} ref:rumPageloadEventsAdaptiveGroups(limit:10,orderBy:[count_DESC],filter:{datetime_geq:\$s,datetime_leq:\$u,siteTag:\$t}){count dimensions{countryName refererHost}}}}}","variables":{"a":"$ACCT","s":"$SINCE","u":"$UNTIL","t":"$BND_TAG"}}
EOF
}
CF_JSON=$(cf_query)

export CF_JSON NOW SINCE UNTIL \
  TS_STARS TS_FORKS TS_WATCH TS_DL TS_VIEWS TS_VU TS_CLONES TS_CU \
  BND_STARS BND_FORKS BND_WATCH BND_DL BND_VIEWS BND_VU BND_CLONES BND_CU

python3 <<'PY'
import json, os
g = lambda k: int(os.environ[k])
now, since, until = os.environ["NOW"], os.environ["SINCE"], os.environ["UNTIL"]
day = now[:10]

cf = json.loads(os.environ["CF_JSON"])
acc = cf["data"]["viewer"]["accounts"][0]
tot = acc["tot"][0] if acc["tot"] else {"count": 0, "sum": {"visits": 0}}
daily = [{"date": x["dimensions"]["date"], "pv": x["count"], "visits": x["sum"]["visits"]} for x in acc["daily"]]
ref = [{"country": x["dimensions"].get("countryName"),
        "referer": x["dimensions"].get("refererHost") or "(direct)",
        "count": x["count"]} for x in acc["ref"]]

repos = {
  "timestep": {
    "label": "Timestep",
    "url": "https://github.com/michaelsweeney/timestep",
    "github": {"stars": g("TS_STARS"), "forks": g("TS_FORKS"), "watchers": g("TS_WATCH"), "downloads": g("TS_DL")},
    "traffic14d": {"views": g("TS_VIEWS"), "viewUniques": g("TS_VU"), "clones": g("TS_CLONES"), "cloneUniques": g("TS_CU")},
  },
  "eplus-bnd-branch-visualizer": {
    "label": "EnergyPlus BND Visualizer",
    "url": "https://github.com/michaelsweeney/eplus-bnd-branch-visualizer",
    "site": "https://eplus-bnd-viz.pages.dev",
    "github": {"stars": g("BND_STARS"), "forks": g("BND_FORKS"), "watchers": g("BND_WATCH"), "downloads": g("BND_DL")},
    "traffic14d": {"views": g("BND_VIEWS"), "viewUniques": g("BND_VU"), "clones": g("BND_CLONES"), "cloneUniques": g("BND_CU")},
    "cf30d": {"pageviews": tot["count"], "visits": tot["sum"]["visits"], "daily": daily, "topReferers": ref},
  },
}

snapshot = {"generated": now, "window": {"since": since, "until": until}, "repos": repos}
with open("snapshot.json", "w") as f:
    json.dump(snapshot, f, indent=2)

# Compact per-run history record (totals only; the rolling daily series lives in snapshot.json)
record = {"date": day, "generated": now,
          "repos": {k: {"stars": v["github"]["stars"],
                        "downloads": v["github"]["downloads"],
                        "views14d": v["traffic14d"]["views"],
                        "cloneUniques14d": v["traffic14d"]["cloneUniques"],
                        **({"cfVisits30d": v["cf30d"]["visits"]} if "cf30d" in v else {})}
                    for k, v in repos.items()}}

# Replace any existing record for today, keep the rest, append the new one.
hist = []
try:
    with open("history.jsonl") as f:
        hist = [json.loads(l) for l in f if l.strip()]
except FileNotFoundError:
    pass
hist = [h for h in hist if h.get("date") != day]
hist.append(record)
hist.sort(key=lambda h: h["generated"])
with open("history.jsonl", "w") as f:
    for h in hist:
        f.write(json.dumps(h) + "\n")

print(f"snapshot.json updated; history.jsonl now has {len(hist)} point(s)")
PY

echo "Done — generated $NOW"
