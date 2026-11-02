// Stands in for the fs worker: starts a long-lived stand-in daemon through the app's launcher, reports its pid, then idles
// until the test kills it.
import { launchTiedToParent } from "../../src/main/tied-launch.ts";

const pid = launchTiedToParent(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
console.log(`DAEMON ${pid}`);
setInterval(() => {}, 1000);
