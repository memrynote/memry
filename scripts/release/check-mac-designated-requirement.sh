#!/bin/sh
# Squirrel.Mac accepts an update bundle only when it satisfies the designated requirement of the
# running app. Usage: check-mac-designated-requirement.sh <old.app> <new.app>
set -eu

old="${1:?usage: check-mac-designated-requirement.sh <old.app> <new.app>}"
new="${2:?new.app}"

requirement="$(codesign -d -r- "$old" 2>&1 | sed -n 's/^designated => //p')"
if [ -z "$requirement" ]; then
  echo "no designated requirement found in $old" >&2
  exit 1
fi

echo "requirement: $requirement"
codesign --verify --strict --verbose=2 --test-requirement="=$requirement" "$new"
