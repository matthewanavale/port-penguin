#!/usr/bin/env bash
# Creates a self-signed certificate for Port Penguin.
# Usage: sudo ./make-self-signed-cert.sh penguin.example.com
set -euo pipefail

DOMAIN="${1:-}"
if [ -z "$DOMAIN" ]; then
  echo "Usage: sudo $0 your.domain.com" >&2
  exit 1
fi

DIR=/etc/ssl/port-penguin
mkdir -p "$DIR"

openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
  -keyout "$DIR/privkey.pem" \
  -out "$DIR/fullchain.pem" \
  -subj "/CN=$DOMAIN" \
  -addext "subjectAltName=DNS:$DOMAIN"

chmod 600 "$DIR/privkey.pem"
chmod 644 "$DIR/fullchain.pem"

echo
echo "Certificate: $DIR/fullchain.pem"
echo "Private key: $DIR/privkey.pem"
echo "Valid for 825 days for $DOMAIN"
