import test from "node:test";
import assert from "node:assert/strict";
import {
  isActiveStatus,
  createRun,
  resetRun,
  findRun,
  hasActiveRun,
  pickActiveRunId,
  removeRun,
  runLabel,
  createCommandDedup,
} from "../../../src/services/run-store.js";

test("isActiveStatus：running / starting 视为进行中", () => {
  assert.equal(isActiveStatus("running"), true);
  assert.equal(isActiveStatus("starting"), true);
  assert.equal(isActiveStatus("exited"), false);
  assert.equal(isActiveStatus("stopped"), false);
  assert.equal(isActiveStatus("failed"), false);
  assert.equal(isActiveStatus(undefined), false);
});

test("createRun：新建记录为 starting，输出与退出码为空", () => {
  const run = createRun({ id: "npm:dev", cmd: "npm run dev", labelKey: "run.script.dev", labelFallback: "Dev", now: 1000 });
  assert.deepEqual(run, {
    id: "npm:dev",
    cmd: "npm run dev",
    labelKey: "run.script.dev",
    labelFallback: "Dev",
    status: "starting",
    exitCode: null,
    output: "",
    stop: null,
    ptyId: null,
    startTime: 1000,
    endTime: null,
  });
});

test("createRun：缺 id 时回退用命令本身作为 id", () => {
  const run = createRun({ cmd: "npm run test" });
  assert.equal(run.id, "npm run test");
});

test("resetRun：清空输出与上一次结果，状态回到 starting", () => {
  const run = createRun({ id: "npm:dev", cmd: "npm run dev" });
  run.status = "exited";
  run.exitCode = 0;
  run.output = "old output";
  run.ptyId = "pty-1";
  run.endTime = 2000;

  resetRun(run, 3000);
  assert.equal(run.status, "starting");
  assert.equal(run.exitCode, null);
  assert.equal(run.output, "");
  assert.equal(run.ptyId, null);
  assert.equal(run.endTime, null);
  assert.equal(run.startTime, 3000);
});

test("findRun / hasActiveRun：按 id 查找与判断是否存在进行中的 run", () => {
  const a = createRun({ id: "npm:dev", cmd: "npm run dev" });
  const b = createRun({ id: "npm:test", cmd: "npm run test" });
  b.status = "exited";
  const runs = [a, b];

  assert.equal(findRun(runs, "npm:dev"), a);
  assert.equal(findRun(runs, "missing"), null);
  assert.equal(findRun(null, "npm:dev"), null);

  assert.equal(hasActiveRun(runs), true);
  b.status = "running";
  assert.equal(hasActiveRun([b]), true);
  assert.equal(hasActiveRun([]), false);
  assert.equal(hasActiveRun(null), false);
});

test("pickActiveRunId：优先保留仍存在的 preferredId，否则取第一条", () => {
  const a = createRun({ id: "npm:dev", cmd: "npm run dev" });
  const b = createRun({ id: "npm:test", cmd: "npm run test" });
  const runs = [a, b];

  assert.equal(pickActiveRunId(runs, "npm:test"), "npm:test");
  assert.equal(pickActiveRunId(runs, "missing"), "npm:dev");
  assert.equal(pickActiveRunId(runs, null), "npm:dev");
  assert.equal(pickActiveRunId([], "npm:dev"), null);
});

test("removeRun：移除并返回被移除的记录，不存在时返回 null", () => {
  const a = createRun({ id: "npm:dev", cmd: "npm run dev" });
  const b = createRun({ id: "npm:test", cmd: "npm run test" });
  const runs = [a, b];

  assert.equal(removeRun(runs, "npm:dev"), a);
  assert.deepEqual(runs, [b]);
  assert.equal(removeRun(runs, "npm:dev"), null);
  assert.equal(removeRun(null, "npm:dev"), null);
});

test("runLabel：优先本地化 labelKey，否则回退原文/命令", () => {
  const t = (key, fallback) => `[${fallback || key}]`;
  assert.equal(runLabel({ labelKey: "run.script.dev", labelFallback: "Dev", cmd: "npm run dev" }, t), "[Dev]");
  assert.equal(runLabel({ labelKey: null, labelFallback: "deploy", cmd: "npm run deploy" }, t), "deploy");
  assert.equal(runLabel({ labelKey: null, labelFallback: "", cmd: "npm run x" }, t), "npm run x");
  assert.equal(runLabel(null, t), "");
});

test("createCommandDedup：窗口内同命令重复触发被跳过，窗口外放行", () => {
  const skip = createCommandDedup(300);
  // 首次触发放行
  assert.equal(skip("npm:generate", 1000), false);
  // 窗口内重复触发（双击 / 连点 / 面板重复挂载）一律跳过
  assert.equal(skip("npm:generate", 1100), true);
  assert.equal(skip("npm:generate", 1299), true);
  // 窗口边界：达到窗口宽度后放行（明确的重新运行意图）
  assert.equal(skip("npm:generate", 1300), false);
  // 不同命令互不影响
  assert.equal(skip("npm:build", 1301), false);
  assert.equal(skip("npm:build", 1302), true);
  // 无 id 不做去重
  assert.equal(skip("", 5000), false);
  assert.equal(skip(null, 5001), false);
});
