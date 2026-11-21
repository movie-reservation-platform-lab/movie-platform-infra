# Harness watcher cadence and rollback evidence

Implemented and verified offline. Live acceptance remains open.

## Goal and evidence

Lease 4 reached a real canary. Build 5's good tasks served successful responses roughly 30 seconds apart. The watcher needed 60 samples per task in five minutes and the release required a heartbeat at most 30 seconds old. The watcher awaited multiple AWS CLI processes per pass. The protected log concealed the exception that ended Build 5, so a stale heartbeat is a hypothesis.

Build 6 started after Build 5 had rolled back. ECS retained both deployment attempts in history. The release task reported failure before ECS recorded the rollback of the bad revision. A historical terminal state cannot prove the outcome of the current release.

## Changes and acceptance checks

1. In the watcher, separate task discovery, attributed HTTP sampling and publication. Bound concurrent work and require fresh identity and health evidence. Preserve the existing coverage window, task count, digest checks, heartbeat limits and missing-data behavior.
2. In the release observer, identify the deployment created by this attempt. Wait for its terminal ECS state and two steady tasks on the expected revision and digest. A verified bad rollback still fails the pipeline and reports the restored original identity.
3. Emit reviewed diagnostic reasons for rejected watch and release checks. Keep raw provider payloads, environment values and credentials out of task errors.
4. Test the watch and release tasks with one clock, shared observations and AWS-call latency representative of the live run. A healthy candidate must finish successfully. A bad candidate must produce a failed release with verified rollback. Prior rollback history, stale observations and incomplete coverage must not produce false success.

On a local container capped at the protected task’s 0.25 vCPU and 512 MiB,
one pinned AWS CLI startup took about seven seconds. Four sequential ECS
process starts alongside two publication process starts took 47 seconds
and 30 seconds respectively, before real AWS latency. Use bundled, persistent
AWS SDK clients for protected task operations. Preserve the request scope,
strongly consistent watcher reads, bounded history and task identity checks.

## Verification and rollout

Both timed rollout cases reproduced the failures on the merged baseline. The fixed
watcher and release passed both cases with 2.5 seconds of latency per AWS call.
Replaying the archived Build 6 observations also verified the return to the
original revision and digest. An observer failure or incomplete coverage raises
the unhealthy metric and leaves candidate evidence pending.

`npm run check:harness-trial` passed, including 78 Harness tests, the
packaged SDK request smoke test and offline CDK synth. Both pinned-base
images built locally. Both rollout cases passed again using the runtime
extracted from the tools image, and the delegate image passed offline evaluation.
At the same resource limit, the final tools image took 402 ms for four warm ECS
calls and 397 ms for two publication calls against a loopback endpoint.

Live acceptance requires a new lease, reviewed code and newly published immutable
images. The previous digests and execution records are in the private lease journal.
