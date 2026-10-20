#!/bin/sh
# Runs infra/seed-inquiry-doctype.py inside the backend container through `bench console`.
# `bench console` is used instead of a bare interpreter because the site context, log paths and
# virtualenv are already correct there. This wrapper exists so the nested quoting lives in one
# place instead of in the caller's shell.
set -e
cd /home/frappe/frappe-bench
printf "%s\n" "exec(open('/tmp/seed.py').read())" | bench --site frontend console
