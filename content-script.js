/**
 * Shopee content-script (deobfuscated and instrumented)
 * What I did:
 * - Reconstructed the original logic in clear, readable code.
 * - Removed string/array/RC4 obfuscation stubs.
 * - Kept the overall behavior, UI and flow in place.
 * - Added console.log at key positions (network calls, storage ops, page checks,
 *   task transitions, timers, DOM updates…).
 *
 * Important:
 * - This file still depends on: dayjs, axios, md5, jQuery ($), and chrome.storage (Chrome extension context).
 * - Fill in config.KEY, config.TASK_API_URL, config.API_VERSION if your original build expects them; I left TODO placeholders.
 * - If you need me to keep the randomized DOM IDs behavior (original tagSign), tell me and I will add it back.
 */

(function () {
  "use strict";

  // -----------------------------
  // Config (fill in the TODOs)
  // -----------------------------
  const config = {
    KEY: "TODO_FILL_KEY", // original was obfuscated
    PALT_NAME: "Shopee",
    VERSION: "Version 6.1 20250516",
    TASK_API_URL: "TODO_FILL_TASK_API_URL", // original was obfuscated
    isDebug: false,
    API_VERSION: "TODO_API_VERSION", // original was obfuscated
  };

  // -----------------------------
  // Globals/state
  // -----------------------------
  let isUpload = false;
  let upLoadTaskTimer = null;

  // UI element IDs (deobfuscated, stable)
  const ID = {
    plugBox: "plugBox",
    bestNewLog: "bestNewLog",
    task_start: "task_start",
    task_get: "task_get",
    task_upload: "task_upload",
    task_success: "task_success",
    task_success_rate: "task_success_rate",
    intervalBig: "intervalBig",
    intervalSmall: "intervalSmall",
    userId: "userId",
    logBtn: "logBtn",
    logList: "logList",
    footerInfo: "footerInfo",
    clearData: "clearData",
  };

  // -----------------------------
  // Helpers
  // -----------------------------
  function getUuid() {
    const url = URL.createObjectURL(new Blob());
    const uuid = url.toString().slice(url.toString().lastIndexOf("/") + 1);
    URL.revokeObjectURL(url);
    return uuid;
  }

  function throttle(fn, delay) {
    let last = 0;
    return function (...args) {
      const now = Date.now();
      if (now - last >= delay) {
        last = now;
        fn.apply(this, args);
      }
    };
  }

  function getRandomInt(min, max) {
    min = Math.ceil(min);
    max = Math.floor(max);
    if (min > max) [min, max] = [max, min];
    return Math.floor(Math.random() * (max - min)) + min;
  }

  // chrome.storage helpers with console
  function getLocalStorage(defaults) {
    return new Promise((resolve, reject) => {
      if (!defaults) {
        console.warn("[content-script] getLocalStorage: no defaults provided");
        return resolve({});
      }
      try {
        if (chrome?.storage?.local) {
          chrome.storage.local.get(defaults, (items) => {
            console.log("[storage.get]", items);
            resolve(items);
          });
        } else {
          // fallback to window.localStorage
          const out = {};
          for (const [k, v] of Object.entries(defaults)) {
            try {
              const raw = localStorage.getItem(k);
              out[k] = raw == null ? v : JSON.parse(raw);
            } catch {
              out[k] = v;
            }
          }
          console.log("[localStorage.get] (fallback)", out);
          resolve(out);
        }
      } catch (e) {
        console.error("[getLocalStorage] error", e);
        reject(e);
      }
    });
  }

  function setLocalStorage(obj) {
    console.log("[storage.set]", obj);
    try {
      if (chrome?.storage?.local) {
        chrome.storage.local.set(obj);
      } else {
        // fallback to window.localStorage
        for (const [k, v] of Object.entries(obj)) {
          localStorage.setItem(k, JSON.stringify(v));
        }
      }
    } catch (e) {
      console.error("[setLocalStorage] error", e);
    }
  }

  // -----------------------------
  // Environment/route checks
  // -----------------------------
  function getAccountId() {
    // original code read csrftoken when present; keep similar detection
    try {
      if (document.cookie.indexOf("csrftoken=") >= 0) {
        const m =
          document.cookie.match(/ csrftoken=(.*?);/) ||
          document.cookie.match(/csrftoken=([^;]+)/);
        if (m && m[1]) return m[1];
      }
    } catch {}
    return "";
  }

  function getSessionId() {
    // similar to getAccountId – in original they also looked for csrftoken
    try {
      if (document.cookie.indexOf("csrftoken=") >= 0) {
        const m =
          document.cookie.match(/ csrftoken=(.*?);/) ||
          document.cookie.match(/csrftoken=([^;]+)/);
        if (m && m[1]) return m[1];
      }
    } catch {}
    return "";
  }

  function checkIsLogin() {
    const accountId = getAccountId();
    const isLogin = !!accountId;
    console.log("[checkIsLogin]", {
      isLogin,
      accountIdShort: accountId ? accountId.slice(0, 6) + "..." : "",
    });
    return isLogin;
  }

  function isVerifyPage() {
    const hit = location.href.includes("verify/traffic");
    console.log("[isVerifyPage]", { url: location.href, hit });
    return hit;
  }

  async function isErrorPage(limitTimes = 1) {
    let isErr = false;
    if (location.href.includes("verify/traffic/error")) {
      let { errorTimes = 0 } = await getLocalStorage({ errorTimes: 0 });
      errorTimes++;
      isErr = true;
      setLog("", {
        status: 0x2718,
        msg: `检测到流量防护错误，第${errorTimes}次`,
        sleep: 0,
      });
      if (errorTimes >= limitTimes) {
        setLog("", {
          status: 0x2718,
          msg: `连续${limitTimes}次触发流量防护，已停止任务`,
          sleep: 0,
        });
        setLocalStorage({ taskStatus: 0, errorTimes: 0 });
        updateDom();
      } else {
        setLocalStorage({ errorTimes });
        clearTimeout(upLoadTaskTimer);
        upLoadTaskTimer = setTimeout(startGetTask, 0x14 * 1000);
      }
    }
    console.log("[isErrorPage]", { url: location.href, isErr });
    return isErr;
  }

  function isLoginPage() {
    const hit = location.href.includes("/buyer/login");
    console.log("[isLoginPage]", { url: location.href, hit });
    return hit;
  }

  function getUrlParams(url) {
    const params = {};
    const regex = /[?&]([^=#]+)=([^&#]*)/g;
    let match;
    while ((match = regex.exec(url))) {
      params[decodeURIComponent(match[1])] = decodeURIComponent(match[2]);
    }
    return params;
  }

  // -----------------------------
  // Logs panel
  // -----------------------------
  async function setLog(uuid, log) {
    const { logs = "[]" } = await getLocalStorage({ logs: "[]" });
    const list = JSON.parse(logs);
    const now = dayjs().format("YYYY-MM-DD HH:mm:ss");
    const nextTime = dayjs()
      .add(log.sleep || 0, "second")
      .format("YYYY-MM-DD HH:mm:ss");
    const item = { time: now, uuid, log, nextTime };
    list.push(item);
    setLocalStorage({ logs: JSON.stringify(list) });
    console.log("[setLog]", item);
    initPanelLogs();
  }

  function createLogHtml(entry, isBestNew = false) {
    const sleepStr = entry.log.sleep === 0 ? "" : ` 休息${entry.log.sleep}秒`;
    const taskCodeStr =
      entry.log.task && entry.log.task.code ? `[${entry.log.task.code}] ` : "";

    if (entry.log.status === 200) {
      return `
<div style="font-size:12px;margin-bottom:4px;line-height:14px;color:#000">
  ${taskCodeStr}${entry.time} ${entry.log.msg}${sleepStr} ${entry.nextTime}
</div>`;
    }

    return `
<div style="font-size:12px;margin-bottom:4px;line-height:14px;color:red">
  ${taskCodeStr}${entry.time} ${entry.log.msg}${sleepStr} ${entry.nextTime}
</div>`;
  }

  async function updateBestNewLog() {
    const { logs = "[]" } = await getLocalStorage({ logs: "[]" });
    const list = JSON.parse(logs);
    $("#" + ID.bestNewLog).empty();
    if (list.length === 0) return;
    const html = createLogHtml(list[list.length - 1], true);
    $("#" + ID.bestNewLog).append(html);
  }

  async function initPanelLogs() {
    try {
      await updateBestNewLog();
      const { logs = "[]" } = await getLocalStorage({ logs: "[]" });
      const list = JSON.parse(logs);
      $("#" + ID.logList).empty();
      if (list.length === 0) return;
      list.forEach((it) => {
        const html = createLogHtml(it);
        $("#" + ID.logList).append(html);
      });
    } catch (e) {
      console.error("[initPanelLogs] error", e);
      setLog(getUuid(), { status: 0x2717, msg: "日志面板渲染失败", sleep: 0 });
      setLocalStorage({ taskStatus: 0 });
      updateDom();
    }
  }

  // -----------------------------
  // UI build and interactions
  // -----------------------------
  function buildPanelHtml(pos) {
    return `
<div id="${ID.plugBox}" style="position:fixed;left:${pos.boxLeft}px;top:${pos.boxTop}px;z-index:999999;user-select:none;border:1px solid #dcdfe6;border-radius:6px;background:#fff; padding:6px; font-family: system-ui, Arial, sans-serif;">
  <div style="display:flex;gap:8px;align-items:flex-start">
    <div id="${ID.bestNewLog}" style="flex:1;"></div>
    <div style="width:70px;font-weight:bold">
      Shopee<br/>v${config.API_VERSION}
    </div>
  </div>

  <div style="display:flex;gap:6px;margin-top:6px">
    <div id="${ID.task_get}" style="font-size:12px">领取: 0</div>
    <div id="${ID.task_upload}" style="font-size:12px">上传: 0</div>
    <div id="${ID.task_success}" style="font-size:12px">成功: 0</div>
    <div id="${ID.task_success_rate}" style="font-size:12px">成功率: -%</div>
  </div>

  <div id="${ID.task_start}" style="margin:8px 0;width:100%;height:30px;background-color:#7280f7;text-align:center;line-height:30px;color:#f7f7f7;border-radius:4px;cursor:pointer">start</div>



  <div style="display:flex;gap:8px;margin-bottom:6px">
    <input id="${ID.intervalSmall}" placeholder="小间隔(秒)" style="width:120px;height:24px;border:1px solid #dcdfe6;border-radius:4px;padding:0 6px" />
    <input id="${ID.intervalBig}" placeholder="大间隔(秒, 最小20)" style="width:160px;height:24px;border:1px solid #dcdfe6;border-radius:4px;padding:0 6px" />
  </div>

  <div id="${ID.footerInfo}" style="height:auto; max-height:180px; overflow:auto; border-top:1px dashed #ddd; padding-top:6px;">
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px">
      <button id="${ID.logBtn}" style="height:24px;border:1px solid #dcdfe6;border-radius:4px;background:#fff;cursor:pointer;">折叠/展开</button>
      <button id="${ID.clearData}" style="height:24px;border:1px solid #dcdfe6;border-radius:4px;background:#fff;cursor:pointer;">清空数据</button>
    </div>
    <div id="${ID.logList}"></div>
  </div>

  <div style="font-size:11px;opacity:0.6;margin-top:6px">${config.VERSION}</div>
</div>`;
  }

  async function updateDom() {
    const state = await getLocalStorage({
      task: {},
      task_get: 0,
      task_upload: 0,
      task_success: 0,
      taskStatus: 0,
      userId: "",
      showFooter: "open", // open|close
      intervalBig: "",
      intervalSmall: "",
    });

    $("#" + ID.intervalBig).val(state.intervalBig);
    $("#" + ID.intervalSmall).val(state.intervalSmall);
    $("#" + ID.task_get).text("领取: " + state.task_get);
    $("#" + ID.task_upload).text("上传: " + state.task_upload);
    $("#" + ID.task_success).text("成功: " + state.task_success);

    let rate = (state.task_success / (state.task_get || 1)) * 100;
    if (isNaN(rate)) rate = "-";
    if (rate > 100) rate = 100;
    $("#" + ID.task_success_rate).text(
      "成功率: " + (rate === "-" ? "-" : rate.toFixed(1)) + "%"
    );

    if (state.taskStatus === 0) {
      $("#" + ID.task_start)
        .text("start")
        .css({ background: "#7280f7", color: "#fff" });
    } else {
      $("#" + ID.task_start)
        .text("stop")
        .css({ background: "#000", color: "#fff" });
    }

    if (state.showFooter === "close") {
      $("#" + ID.footerInfo).css("height", "0px");
    } else {
      $("#" + ID.footerInfo).css("height", "auto");
    }

    console.log("[updateDom]", state);
    initPanelLogs();
  }

  function attachDrag(box) {
    // mouse
    box.addEventListener("mousedown", (e) => {
      const offsetX = e.clientX - box.offsetLeft;
      const offsetY = e.clientY - box.offsetTop;

      const onMove = throttle((ev) => {
        box.style.left = ev.clientX - offsetX + "px";
        box.style.top = ev.clientY - offsetY + "px";
        setLocalStorage({
          boxLeft: ev.clientX - offsetX,
          boxTop: ev.clientY - offsetY,
        });
      }, 16);

      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });

    // touch
    box.addEventListener("touchstart", (e) => {
      const t = e.touches[0];
      const offsetX = t.clientX - box.offsetLeft;
      const offsetY = t.clientY - box.offsetTop;

      const onMove = throttle((ev) => {
        const tt = ev.touches[0];
        box.style.left = tt.clientX - offsetX + "px";
        box.style.top = tt.clientY - offsetY + "px";
        setLocalStorage({
          boxLeft: tt.clientX - offsetX,
          boxTop: tt.clientY - offsetY,
        });
      }, 16);

      const onEnd = () => {
        document.removeEventListener("touchmove", onMove);
        document.removeEventListener("touchend", onEnd);
      };

      document.addEventListener("touchmove", onMove, { passive: false });
      document.addEventListener("touchend", onEnd);
    });
  }

  // -----------------------------
  // API (getTask / pushTask)
  // -----------------------------
  async function getTask({ uuid, userId, code }) {
    const headers = {
      authorization: config.KEY,
      version: config.VERSION,
      version_cus: config.API_VERSION,
      device: "chrome_ext",
      account_id: md5(getAccountId()),
      session_id: md5(getSessionId()),
      user_id: userId,
      ct: Math.floor(Date.now() / 1000),
    };

    const url = `${config.TASK_API_URL}/task/get?code=${encodeURIComponent(
      code
    )}${config.isDebug ? "&debug=true" : ""}`;
    console.log("[getTask] ->", { url, headers });

    try {
      const res = await axios.get(url, { headers });
      console.log("[getTask] <-", res.status, res.data);
      if (res.status === 204) {
        return {
          status: res.status,
          sleep: res.headers?.sleep_time || 20,
          code,
        };
      }
      return { status: res.status, ...res.data, code };
    } catch (err) {
      console.error("[getTask] error", err);
      return {
        status: err?.response?.status || 500,
        ...(err?.response?.data || {}),
        code,
      };
    }
  }

  async function pushTask(payload, code, userId) {
    const headers = {
      authorization: config.KEY,
      version: config.VERSION,
      version_cus: config.API_VERSION,
      device: "chrome_ext",
      account_id: md5(getAccountId()),
      session_id: md5(getSessionId()),
      user_id: userId,
      ct: Math.floor(Date.now() / 1000),
    };

    const url = `${config.TASK_API_URL}/task/push?code=${encodeURIComponent(
      code
    )}${config.isDebug ? "&debug=true" : ""}`;
    console.log("[pushTask] ->", { url, headers, payload });

    try {
      const res = await axios.post(url, payload, { headers });
      console.log("[pushTask] <-", res.status, res.data);
      if (res.status === 204) {
        return { status: res.status, sleep: res.headers?.sleep_time || 120 };
      }
      return { status: res.status, ...res.data };
    } catch (err) {
      console.error("[pushTask] error", err);
      return {
        status: err?.response?.status || 500,
        ...(err?.response?.data || {}),
      };
    }
  }

  // -----------------------------
  // Core workflow
  // -----------------------------
  async function getSleepTime() {
    const { intervalBig = "", intervalSmall = "" } = await getLocalStorage({
      intervalBig: "",
      intervalSmall: "",
    });
    if (intervalSmall && intervalBig) {
      let v = getRandomInt(
        parseInt(intervalSmall, 10),
        parseInt(intervalBig, 10)
      );
      if (v >= 1) return v;
      return 1;
    }
    return "";
  }

  function checkUserIdLegal() {
    const val = $("#" + ID.userId).val();
    // if (val == "") {
    //   setLog("", { status: 0x2711, msg: "手机号不能为空", sleep: 0 });
    //   return false;
    // }
    const pat = /^[1][3-9][0-9]{9}$/;
    // if (!pat.test(val)) {
    //   setLog("", { status: 0x2712, msg: "手机号格式不正确", sleep: 0 });
    //   return false;
    // }
    return true;
  }

  async function checkCanPush(rawData) {
    try {
      let can = true;
      const { task = {}, taskStatus = 0 } = await getLocalStorage({
        task: {},
        taskStatus: 0,
      });
      let sleep = taskStatus === 1 ? 20 : 0;

      if (isVerifyPage()) {
        can = false;
        setLog("", {
          status: 0x2718,
          msg: "命中流量防护校验页，不上传",
          sleep: 0,
        });
        updateDom();
        return can;
      }

      if (await isErrorPage(1)) {
        can = false;
        return can;
      }

      if (JSON.stringify(task) === "{}") {
        setLog("", { status: 0x2714, msg: "未领取任务，不上传", sleep });
        can = false;
      } else if (!rawData) {
        setLog("", { status: 0x2715, msg: "未采集到数据，不上传", sleep });
        can = false;
      }

      if (taskStatus === 1 && can === false) {
        clearTimeout(upLoadTaskTimer);
        upLoadTaskTimer = setTimeout(startGetTask, sleep * 1000);
      }
      return can;
    } catch (e) {
      console.error("[checkCanPush] error", e);
      const { taskStatus = 0 } = await getLocalStorage({ taskStatus: 0 });
      if (taskStatus === 1) {
        setLog("", { status: 0x2716, msg: "采集出错", sleep: 20 });
        clearTimeout(upLoadTaskTimer);
        upLoadTaskTimer = setTimeout(startGetTask, 20 * 1000);
      }
      return false;
    }
  }

  async function pushTaskResult(data) {
    const {
      task = {},
      taskStatus = 0,
      userId = "",
      task_upload = 0,
    } = await getLocalStorage({
      task: {},
      taskStatus: 0,
      userId: "",
      task_upload: 0,
    });

    const code = dayjs().format("YYYYMMDDHHmmss");
    const uuid = getUuid();
    const dto = {
      getDto: task.getDto,
      data,
      url: window.location.href,
    };

    setLocalStorage({ task_upload: task_upload + 1 });

    const res = await pushTask(dto, code, userId);
    setLocalStorage({ task: {} });
    res.code = code;

    const sleep = await getSleepTime();
    if (sleep) {
      res.sleep_time = sleep;
    } else {
      res.sleep_time = getRandomInt(5, 10);
    }

    switch (res.status) {
      case 200:
        setLog(uuid, {
          status: res.status,
          msg: res.msg || "上传成功",
          sleep: res.sleep_time || 10,
          task: res,
        });
        const { task_success = 0 } = await getLocalStorage({ task_success: 0 });
        setLocalStorage({ task_success: task_success + 1 });
        clearTimeout(upLoadTaskTimer);
        upLoadTaskTimer = setTimeout(
          () => startGetTask(),
          (res.sleep_time || 10) * 1000
        );
        break;
      case 500:
        setLog(uuid, {
          status: res.status,
          msg: res.msg || "服务繁忙，请稍后重试",
          sleep: res.sleep_time || 120,
          task: res,
        });
        clearTimeout(upLoadTaskTimer);
        upLoadTaskTimer = setTimeout(
          () => startGetTask(),
          (res.sleep_time || 120) * 1000
        );
        break;
      default:
        setLog(uuid, {
          status: res.status,
          msg: res.msg || "上传失败",
          sleep: res.sleep_time || 120,
          task: res,
        });
        clearTimeout(upLoadTaskTimer);
        upLoadTaskTimer = setTimeout(
          () => startGetTask(),
          (res.sleep_time || 120) * 1000
        );
        break;
    }

    updateDom();
  }

  async function startGetTask() {
    const code = dayjs().format("YYYYMMDDHHmmss");
    const state = await getLocalStorage({
      task_get: 0,
      taskStatus: 0,
      userId: "",
    });
    const pat = /^[1][3-9][0-9]{9}$/;

    // if (state.userId == "") {
    //   setLog(getUuid(), { status: 0x2717, msg: "请输入手机号", sleep: 0 });
    //   setLocalStorage({ taskStatus: 0 });
    //   updateDom();
    //   return;
    // }
    // if (!pat.test(state.userId)) {
    //   setLog(getUuid(), { status: 0x2718, msg: "手机号格式不正确", sleep: 0 });
    //   setLocalStorage({ taskStatus: 0 });
    //   updateDom();
    //   return;
    // }

    if (state.taskStatus === 0) {
      $("#" + ID.task_start)
        .text("start")
        .css({ background: "#7280f7", color: "#fff" });
    }

    const uuid = getUuid();
    const res = await getTask({ uuid, userId: state.userId, code });
    res.code = code;

    switch (res.status) {
      case 200: {
        setLog(uuid, {
          status: res.status,
          msg: "领取成功",
          task: res,
          sleep: 0,
        });
        isUpload = false;
        setLocalStorage({ task: res, task_get: state.task_get + 1 });

        // Navigate to task url if provided
        if (res?.data?.url) {
          console.log("[startGetTask] navigate to", res.data.url);
          window.location.href = res.data.url;
        }
        break;
      }
      case 204: {
        const sleep = res.sleep || 20;
        setLog(uuid, {
          status: res.status,
          msg: "队列空闲，稍后再试",
          task: res,
          sleep,
        });
        clearTimeout(upLoadTaskTimer);
        upLoadTaskTimer = setTimeout(() => startGetTask(), sleep * 1000);
        break;
      }
      case 500: {
        const sleep = res.sleep_time || 50;
        setLog(uuid, {
          status: res.status,
          msg: res.msg || "任务队列为空",
          task: res,
          sleep,
        });
        clearTimeout(upLoadTaskTimer);
        upLoadTaskTimer = setTimeout(() => startGetTask(), sleep * 1000);
        break;
      }
      default: {
        const sleep = res.sleep_time || 50;
        setLog(uuid, {
          status: res.status,
          msg: res.msg || "领取失败",
          task: res,
          sleep,
        });
        clearTimeout(upLoadTaskTimer);
        upLoadTaskTimer = setTimeout(() => startGetTask(), sleep * 1000);
        break;
      }
    }
  }

  // periodic supervisor (deadFun)
  async function deadFun() {
    const { intervalBig = "", intervalSmall = "" } = await getLocalStorage({
      intervalBig: "",
      intervalSmall: "",
    });
    let big = 20;
    if (intervalBig && intervalSmall) {
      big = parseInt(intervalBig, 10);
      if (big < 20) big = 20;
    }

    setInterval(async () => {
      if (upLoadTaskTimer) return;
      const { taskStatus = 0 } = await getLocalStorage({ taskStatus: 0 });
      if (taskStatus === 1 && !isVerifyPage()) {
        console.log("[deadFun] watchdog triggering startGetTask");
        startGetTask();
      }
    }, big * 1000);
  }

  // -----------------------------
  // PostMessage listener (original listened for scraped results)
  // -----------------------------
  window.addEventListener("message", async function (ev) {
    if (ev.source !== window) return;
    try {
      if (ev.data?.type === "SPIDER_TASK_DATA") {
        const data = JSON.parse(ev.data.payload);
        console.log("[message] SPIDER_TASK_DATA", data);

        // if data has error, early log and abort upload
        if (data.error && data.error !== "") {
          setLog("", { status: data.error, msg: "采集数据包含错误", sleep: 0 });
          return;
        }

        const canPush = await checkCanPush(ev.data.payload);
        if (canPush && !isUpload) {
          isUpload = true;
          pushTaskResult(data);
        }
      }
    } catch (e) {
      console.error("[message] handler error", e);
    }
  });

  // -----------------------------
  // DOM ready: inject panel and bind events
  // -----------------------------
  $(document).ready(async function () {
    console.log("Shopee 插件已加载！");

    const pos = await getLocalStorage({ boxLeft: 10, boxTop: 10 });
    const html = buildPanelHtml(pos);
    $("body").append(html);

    updateDom();

    const box = document.getElementById(ID.plugBox);
    attachDrag(box);

    // Toggle footer
    $("#" + ID.logBtn).on("click", async () => {
      const { showFooter = "open" } = await getLocalStorage({
        showFooter: "open",
      });
      if (showFooter === "close") {
        setLocalStorage({ showFooter: "open" });
        $("#" + ID.footerInfo).css("height", "auto");
      } else {
        setLocalStorage({ showFooter: "close" });
        $("#" + ID.footerInfo).css("height", "0px");
      }
    });

    // Clear data
    $("#" + ID.clearData).on("click", () => {
      setLocalStorage({
        task: {},
        task_get: 0,
        task_upload: 0,
        task_success: 0,
        taskStatus: 0,
        userId: "",
        logs: "[]",
      });
      updateDom();
      console.log("[clearData] done");
    });

    // intervalSmall input
    $("#" + ID.intervalSmall).on("input", async (e) => {
      const v = e.target.value.replace(/[^0-9]/g, "");
      setLocalStorage({ intervalSmall: v });
      e.target.value = v;
    });

    // intervalBig input
    $("#" + ID.intervalBig).on("input", async (e) => {
      const v = e.target.value.replace(/[^0-9]/g, "");
      setLocalStorage({ intervalBig: v });
      e.target.value = v;
    });

    // Start/Stop
    $("#" + ID.task_start).on("click", async () => {
      setLocalStorage({ userId: $("#" + ID.userId).val() });
      const text = $("#" + ID.task_start).text();
      if (text === "start") {
        if (!checkUserIdLegal()) return;
        setLocalStorage({ taskStatus: 1 });
        $("#" + ID.task_start)
          .text("stop")
          .css({ background: "#000", color: "#fff" });
        startGetTask();
      } else {
        $("#" + ID.task_start)
          .text("start")
          .css({ background: "#7280f7", color: "#fff" });
        setLocalStorage({ taskStatus: 0 });
        setLog(getUuid(), { status: 200, msg: "已停止", sleep: 0 });
      }
    });

    // Page checks -> tips
    if (isVerifyPage()) {
      setLog("", { status: 0x2718, msg: "当前为验证页", sleep: 0 });
      updateDom();
    }
    if (await isErrorPage(1)) {
      // handled inside
    }
    if (isLoginPage()) {
      setLog("", { status: 0x2718, msg: "当前为登录页", sleep: 0 });
      setLocalStorage({ taskStatus: 0 });
    }

    updateDom();
  });

  // -----------------------------
  // Watchdog starter
  // -----------------------------
  deadFun();

  // -----------------------------
  // Inject page-level script (optional)
  // -----------------------------
  try {
    const script = document.createElement("script");
    script.src = chrome?.runtime?.getURL
      ? chrome.runtime.getURL("injected.js")
      : "";
    script.onload = function () {
      console.log("Injected script loaded and executed.");
      this.remove();
    };
    (document.head || document.documentElement).appendChild(script);
  } catch (e) {
    console.warn("[inject] failed", e);
  }
})();
