// Windows terminates a child immediately on child.kill('SIGTERM'). Exercise the daemon's
// actual signal handler via this fixture-only IPC channel on every platform.
process.on('message', (message) => { if (message === 'shutdown') process.emit('SIGTERM'); });
