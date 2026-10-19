// Throws on a line this file names, through both loader layers: babel's,
// which puts the refresh prelude above it, and hot-module-replacement's,
// which puts its preamble above that and rewrites the import below.
import React from 'react';

export function fail() {
  throw new Error('thrown on line 7');
}

export default function Thrower() {
  return <box />;
}
