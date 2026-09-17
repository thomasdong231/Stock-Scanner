# Stock Scanner

A local scanner for U.S. stock listings. It filters by price, change, volume, daily VWAP position, market cap, and sector, then shows the matching stocks in a sortable table.

## Run

```bash
/Users/thomasdong/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server.js
```

Then open:

```text
http://localhost:4173
```

## Data Source

The app uses Nasdaq's public stock screener endpoint for listing data and TradingView's U.S. scanner snapshot for the current session VWAP. Both responses are cached for 60 seconds. If TradingView is temporarily unavailable, basic Nasdaq filters continue to work while VWAP-dependent scans report the source issue.
