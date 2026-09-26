---
sidebar_position: 4
title: Voice capacity
description: How many simultaneous conversations a server's GPU carries
---

# Voice capacity

How many conversations can run at once depends on the GPU that runs speech
recognition and the text-to-speech voice. The number is **measured, not
configured**: STELLA has no software cap on sessions, and the GPU is what
slows the voice down first.

## Where to see it

**Settings → Admin → Voice capacity** shows, for each server and GPU, the
number of simultaneous conversations that stayed fluent, the GPU it was
measured on and the date, with a table of what each tested level looked like.
"At least N" means the test stopped at its highest level without finding the
limit.

Until a load test has been run on a server, the card says "Not measured yet".

## Measuring your server

Run the load test in `scripts/load-test/`. It simulates more and more
simultaneous sessions until speech recognition or the voice degrades, and can
publish the result to the dashboard. See
[`scripts/load-test/README.md`](https://github.com/c4dhi/STELLA/blob/development/scripts/load-test/README.md)
for the setup, what counts as "degraded", and the options.

Measure on the GPU you deploy on and without other load. A GPU that is faster
or slower than the one measured will carry a different number.
