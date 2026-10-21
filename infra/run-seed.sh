#!/bin/sh
# Runs a python file inside the backend container through `bench console`.
# $1 is the file inside the container; it defaults to the inquiry seed.
# `bench console` is used instead of a bare interpreter because the site context, log paths and
# virtualenv are already correct there. This wrapper exists so the nested quoting lives in one
# place instead of in the caller's shell.
set -e
target="${1:-/tmp/seed.py}"
cd /home/frappe/frappe-bench
printf "%s\n" "exec(open('$target').read())" | bench --site frontend console
