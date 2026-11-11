const { openIsolationLab } = require('../src/extensions/host-lab/supervisor.cjs');

openIsolationLab(process.argv[2]).then(host => {
  process.send({ pid: host.pid, launcherPid: host.launcherPid });
}, error => {
  process.send({ error: error.message });
  process.exitCode = 1;
});
