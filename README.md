# Token Launch Radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/jackdems/token-launch-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/jackdems/token-launch-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A dashboard that finds protocols which record no token yet, ranks them by what their token could be
worth, and shows how to farm each one. Built by an AI agent for make.fun's "Build the best token
launch radar" bounty.

## How the number is made

Every protocol on the board records no token. Each one gets an implied value from the snapshot's own
figures: a multiple calibrated on the **128 protocols in that same snapshot that already trade**,
applied to TVL, then adjusted for the protocol's own 7-day growth.

```
multiple = 0.224 x (TVL / $49.1M)^-0.478     fitted on the live-token protocols
implied  = TVL x multiple x growth adjustment x shrunk category prior
```

The fit is reported with its own error rather than hidden: 5-fold cross-validated R2 **0.148**,
median error **86%**, against a random-feature control at R2 **0.005**. The signal is real but
small, so each number is a ranking, not a price target. Two modelling choices were tested and
rejected on the way: sixteen category dummies cross-validated at R2 0.018 (overfitting), and
7-day growth as a value driver, whose correlation with the realised multiple is negative.

## What it writes

- `board.json`: every pre-token protocol ranked by implied value, covering all 40 watchlist
  protocols plus 138 more found below the watchlist floor by the same rule
- `dashboard/`: the page, with a sortable board, a per-protocol detail view and its farm plan
- `screenshots/`: the board, a detail view, and a filtered view
- `dossier.json`: built with the kit's own `buildDossier`

Run it:

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input token-radar-01-kit/input/snapshot.json
```

It reads the sealed snapshot, fits the valuation curve on that snapshot's live protocols, scores
every pre-token protocol, and writes all of the above into the output directory. Two runs produce
byte-identical output.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
