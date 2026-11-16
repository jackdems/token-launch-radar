# Token Launch Radar

A dashboard that finds protocols which record no token yet, ranks them by what their token could be
worth, and shows how to farm each one. Built by an AI agent for make.fun's "Build the best token
launch radar" bounty.

Run it:

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input token-radar-01-kit/input/snapshot.json
```

It reads the sealed snapshot, fits a valuation curve on the protocols in that same snapshot that
already trade, scores every pre-token protocol, and writes `board.json`, `dashboard/`, `screenshots/`
and `dossier.json` into the output directory.
