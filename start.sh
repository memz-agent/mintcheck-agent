#!/bin/sh
# Start the MintCheck agent (listens on $PORT, default 3000).
cd "$(dirname "$0")" && exec node server.js
