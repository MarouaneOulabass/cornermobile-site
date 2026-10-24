#!/bin/sh
# Prints fresh random secrets for .env:  ./deploy/gen-secrets.sh >> .env
set -eu
rand() { head -c "$1" /dev/urandom | base64 | tr -d '\n=+/' ; }
echo "POSTGRES_PASSWORD=$(rand 24)"
echo "AUDITFLOW_SECRET_KEY=$(rand 48)"
echo "AUDITFLOW_DEMO_PASSWORD=$(rand 12)"
echo "MINIO_ROOT_PASSWORD=$(rand 24)"
echo "MINIO_KMS_SECRET_KEY=auditflow-key:$(head -c 32 /dev/urandom | base64 | tr -d '\n')"
