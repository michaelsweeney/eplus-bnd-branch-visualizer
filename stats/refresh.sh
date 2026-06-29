#!/usr/bin/env bash
# Regenerate stats/snapshot.json with the auth-gated metrics
# (Cloudflare Pages visits + GitHub repo traffic) that the static
# dashboard cannot fetch client-side. Public numbers (stars, release
# downloads) are fetched live by dashboard.html itself.
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

gh_traffic () { # repo metric -> "count uniques"
  gh api "repos/michaelsweeney/$1/traffic/$2" --jq '"\(.count) \(.uniques)"' 2>/dev/null || echo "0 0"
}
read -r TS_VIEWS TS_VU   < <(gh_traffic timestep views)
read -r TS_CLONES TS_CU  < <(gh_traffic timestep clones)
read -r BND_VIEWS BND_VU < <(gh_traffic eplus-bnd-branch-visualizer views)
read -r BND_CLONES BND_CU< <(gh_traffic eplus-bnd-branch-visualizer clones)

# Cloudflare Pages: 30-day visits + daily series for the bnd-viz site
cf_query () {
  cat <<EOF | curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data @- "$GQL"
{"query":"query(\$a:String!,\$s:Time!,\$u:Time!,\$t:String!){viewer{accounts(filter:{accountTag:\$a}){tot:rumPageloadEventsAdaptiveGroups(limit:1,filter:{datetime_geq:\$s,datetime_leq:\$u,siteTag:\$t}){count sum{visits}} daily:rumPageloadEventsAdaptiveGroups(limit:100,orderBy:[date_ASC],filter:{datetime_geq:\$s,datetime_leq:\$u,siteTag:\$t}){count sum{visits} dimensions{date}} ref:rumPageloadEventsAdaptiveGroups(limit:10,orderBy:[count_DESC],filter:{datetime_geq:\$s,datetime_leq:\$u,siteTag:\$t}){count dimensions{countryName refererHost}}}}}","variables":{"a":"$ACCT","s":"$SINCE","u":"$UNTIL","t":"$BND_TAG"}}
EOF
}
CF_JSON=$(cf_query)

python3 - "$NOW" "$SINCE" "$UNTIL" <<PY > snapshot.json
import json, sys
now, since, until = sys.argv[1], sys.argv[2], sys.argv[3]
cf = json.loads('''$CF_JSON''')
acc = cf["data"]["viewer"]["accounts"][0]
tot = acc["tot"][0] if acc["tot"] else {"count":0,"sum":{"visits":0}}
daily = [{"date":g["dimensions"]["date"],"pv":g["count"],"visits":g["sum"]["visits"]} for g in acc["daily"]]
ref = [{"country":g["dimensions"].get("countryName"),"referer":g["dimensions"].get("refererHost") or "(direct)","count":g["count"]} for g in acc["ref"]]
out = {
  "generated": now,
  "window": {"since": since, "until": until},
  "repos": {
    "timestep": {
      "label": "Timestep",
      "url": "https://github.com/michaelsweeney/timestep",
      "traffic14d": {"views": $TS_VIEWS, "viewUniques": $TS_VU, "clones": $TS_CLONES, "cloneUniques": $TS_CU}
    },
    "eplus-bnd-branch-visualizer": {
      "label": "EnergyPlus BND Visualizer",
      "url": "https://github.com/michaelsweeney/eplus-bnd-branch-visualizer",
      "site": "https://eplus-bnd-viz.pages.dev",
      "traffic14d": {"views": $BND_VIEWS, "viewUniques": $BND_VU, "clones": $BND_CLONES, "cloneUniques": $BND_CU},
      "cf30d": {"pageviews": tot["count"], "visits": tot["sum"]["visits"], "daily": daily, "topReferers": ref}
    }
  }
}
print(json.dumps(out, indent=2))
PY

echo "Wrote $(pwd)/snapshot.json (generated $NOW)"
