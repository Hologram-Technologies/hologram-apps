# Holo Linux — verify it yourself

Holo Linux boots a **real riscv64 Linux 6.6 kernel** on a **real Debian 13 (trixie)**
rootfs, entirely in a browser tab. Don't take that on faith — prove it. Everything
below is run in the live shell; none of it can be faked by a scripted terminal.

## It's a real kernel (not a mock)

Click **✓ verify it yourself**, or type these:

| command | what it proves |
|---|---|
| `uname -a` | kernel release + SMP build + arch `riscv64`, straight from the running kernel |
| `grep -E 'isa\|mmu\|hart' /proc/cpuinfo` | `/proc` is kernel-synthesised: real RISC-V harts, ISA extensions, `sv57` MMU |
| `ls -d /proc/[0-9]*; cat /proc/1/comm` | real PIDs in a real process table; PID 1 is `init` |
| `dmesg \| tail` | the kernel's own boot ring buffer |
| `mount` | real VFS — `ext4` root on the virtio κ-disk, plus proc/sysfs/devtmpfs |
| `cat /proc/sys/kernel/random/uuid` (twice) | two different UUIDs from the kernel CSPRNG, not a constant |
| `holo-verify` | runs the whole suite at once (the script ships inside the rootfs) |
| `holo-help` | lists every command that actually exists here (probed live) |

There is **no compiler, editor, or network stack** in this image — `holo-help` shows
that honestly rather than pretending. The toolset is bash + full coreutils +
grep/sed/awk/perl + tar/gzip + apt/dpkg + procfs tools.

## It's anchored in the κ-substrate (integrity by construction)

The κ rail at the top shows the content address (SHA-256) of the kernel and rootfs.
Before a single guest instruction runs, the browser re-derives those hashes and
refuses to boot on any mismatch (Law L5). The kernel's κ equals the canonical
substrate pin at `/boot/kernel.uor.json`.

- Click **⚠ tamper test** — it flips one byte of the rootfs before the gate. The
  gate catches it and refuses to boot. One byte → boot denied.

## It's 100% serverless (no backend, no VM host)

- Click **⬇ make offline** — caches the whole machine (shell + engine + kernel +
  rootfs, ~36 MB) into the browser.
- Click **✈ offline boot** — blocks *all* network at the service worker, then
  cold-boots from cache only. Linux still comes up. Zero bytes from any server.
- Or prove it the hard way: load once, stop the server
  (`holo-os/system/tools/holo-serve-fhs.mjs`), and reload — it still boots.

## Run it

```
node holo-os/system/tools/holo-serve-fhs.mjs 8377
# open http://127.0.0.1:8377/apps/holo-linux/index.html
```

The rootfs overlay (login banner, `holo-help`, `holo-verify`) is reproducible:
`bash build/build-rootfs.sh` rebuilds `os-rootfs.tar.gz` from the pristine Debian
base + `rootfs-overlay/` and re-pins its κ in `kappa.json`.
