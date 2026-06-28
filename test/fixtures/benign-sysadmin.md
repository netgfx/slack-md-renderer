# Rescue Procedures

If a host fails to reach multi-user state, drop to the rescue target:

    systemctl isolate rescue.target

From there you can inspect logs with `journalctl -xb` and remount the root
filesystem read-write if needed. Re-enable normal boot with `systemctl default`
once the issue is resolved.
