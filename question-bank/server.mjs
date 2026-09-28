import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT) || 8787;
const ACCESS_KEY = process.env.QUESTION_BANK_KEY || "";
const MATCH_THRESHOLD = 75;
const DATA_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "data", "questions.json");
const ADMIN_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "public", "admin.html");

const html = (res, content) => {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(content);
};

const json = (res, status, payload) => {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, referer, u, t",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS"
  });
  res.end(body);
};

const miss = (msg) => ({
  code: 10003,
  data: { answer: [], num: "", usenum: "" },
  msg
});

const ok = (answers, total, extra = {}) => ({
  code: 200,
  data: {
    answer: answers,
    num: String(total),
    usenum: "1"
  },
  msg: extra.msg || "ok",
  ...extra
});

const TEMPLATE = {
  说明: "type：0单选 1多选 2填空 3判断 4简答。options 填全部选项正文。answers 填正确项正文，不要写 A/B/C。填好 questions 后，到管理页一键导入。",
  questions: [
    {
      title: "绿色植物在光照下释放氧气，主要是因为",
      type: "0",
      options: ["呼吸作用", "光合作用", "蒸腾作用", "渗透作用"],
      answers: ["光合作用"]
    },
    {
      title: "下列属于可再生资源的是",
      type: "1",
      options: ["煤炭", "太阳能", "风能", "石油"],
      answers: ["太阳能", "风能"]
    },
    {
      title: "地球绕太阳公转一周大约是一年",
      type: "3",
      options: ["正确", "错误"],
      answers: ["正确"]
    },
    {
      title: "中国的首都是",
      type: "2",
      options: [],
      answers: ["北京"]
    }
  ]
};

const downloadJson = (res, filename, payload) => {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename}"`
  });
  res.end(body);
};

const normalizeTitle = (text) => String(text || "")
  .replace(/<[^>]+>/g, "")
  .replace(/&nbsp;/gi, " ")
  .replace(/^\s*\d+\s*[.、．)）]\s*/, "")
  .replace(/^【[^】]*】\s*/, "")
  .replace(/[（(]\s*\d+\s*分\s*[)）]/g, "")
  .replace(/[\s\u00a0]+/g, "")
  .replace(/[,.，。、：；？！'""''「」【】《》（）()[\]{}<>]/g, "")
  .toLowerCase();

const levenshtein = (left, right) => {
  const distances = Array.from({ length: left.length + 1 }, (_, index) => index);
  for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
    let previous = distances[0];
    distances[0] = rightIndex + 1;
    for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
      const current = distances[leftIndex + 1];
      distances[leftIndex + 1] = left[leftIndex] === right[rightIndex]
        ? previous
        : Math.min(previous, distances[leftIndex], current) + 1;
      previous = current;
    }
  }
  return distances[left.length];
};

const similarity = (left, right) => {
  if (!left || !right) return 0;
  if (left === right) return 100;
  const maxLength = Math.max(left.length, right.length);
  return Math.round((1 - levenshtein(Array.from(left), Array.from(right)) / maxLength) * 100);
};

const scoreTitle = (needle, hay) => {
  if (hay === needle) return 100;
  if (needle.length >= 6 && (hay.includes(needle) || needle.includes(hay))) {
    const ratio = Math.min(hay.length, needle.length) / Math.max(hay.length, needle.length);
    return Math.round(80 * ratio + 15);
  }
  return similarity(hay, needle);
};

const loadQuestions = () => {
  const raw = fs.readFileSync(DATA_FILE, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("questions.json 必须是数组");
  }
  return parsed;
};

const saveQuestions = (questions) => {
  fs.writeFileSync(DATA_FILE, `${JSON.stringify(questions, null, 2)}\n`, "utf8");
};

const normalizeAnswers = (answers) => {
  if (!Array.isArray(answers)) return [];
  return answers.map((item) => String(item || "").trim()).filter(Boolean);
};

const rankQuestion = (questions, title, type) => {
  const needle = normalizeTitle(title);
  if (!needle) return { item: null, index: -1, score: -1 };
  let best = null;
  let bestIndex = -1;
  let bestScore = -1;
  questions.forEach((item, index) => {
    const hay = normalizeTitle(item.title);
    if (!hay) return;
    let score = scoreTitle(needle, hay);
    if (type && item.type != null && String(item.type) === String(type) && score >= MATCH_THRESHOLD) {
      score += 1;
    }
    if (score > bestScore) {
      best = item;
      bestIndex = index;
      bestScore = score;
    }
  });
  return { item: best, index: bestIndex, score: bestScore };
};

const findQuestion = (questions, title, type) => {
  const ranked = rankQuestion(questions, title, type);
  return ranked.score >= MATCH_THRESHOLD ? ranked.item : null;
};

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const text = Buffer.concat(chunks).toString("utf8").trim();
    if (!text) {
      resolve({});
      return;
    }
    try {
      resolve(JSON.parse(text));
    } catch (error) {
      reject(error);
    }
  });
  req.on("error", reject);
});

const isAuthorized = (body) => {
  if (!ACCESS_KEY) return true;
  return String(body.key || "") === ACCESS_KEY;
};

const handleSearch = (questions, body) => {
  if (!isAuthorized(body)) {
    return miss("密钥错误");
  }
  const matched = findQuestion(questions, body.question, body.type);
  const answers = normalizeAnswers(matched?.answers);
  if (!answers.length) {
    return miss("未查询到答案");
  }
  return ok(answers, questions.length);
};

const probeQuestion = (item) => {
  if (!item) return null;
  return {
    title: item.title || "",
    no: item.no == null ? "" : String(item.no),
    type: item.type == null ? "" : String(item.type),
    options: Array.isArray(item.options) ? item.options.map((entry) => String(entry)) : [],
    answers: normalizeAnswers(item.answers)
  };
};

const handleProbe = (questions, body) => {
  if (!isAuthorized(body)) {
    return { status: 401, payload: { code: 401, matched: false, threshold: MATCH_THRESHOLD, score: 0, index: -1, question: null, answers: [], msg: "密钥错误" } };
  }
  const title = String(body.question || body.title || "").trim();
  if (!title) {
    return { status: 400, payload: { code: 400, matched: false, threshold: MATCH_THRESHOLD, score: 0, index: -1, question: null, answers: [], msg: "请填写题干" } };
  }
  const ranked = rankQuestion(questions, title, body.type);
  const close = ranked.score >= 30;
  const question = close ? probeQuestion(ranked.item) : null;
  const answers = question?.answers || [];
  const matched = ranked.score >= MATCH_THRESHOLD && answers.length > 0;
  let msg = `不会作答 · ${Math.max(0, ranked.score)} 分（需 ≥ ${MATCH_THRESHOLD}）`;
  if (!questions.length) msg = "题库还没有题目";
  else if (matched) msg = `会作答 · ${ranked.score} 分`;
  else if (ranked.score >= MATCH_THRESHOLD) msg = `找到题但没有答案 · ${ranked.score} 分`;
  else if (question) msg = `不会作答 · 最接近 ${ranked.score} 分（需 ≥ ${MATCH_THRESHOLD}）`;
  return {
    status: 200,
    payload: {
      code: 200,
      matched,
      threshold: MATCH_THRESHOLD,
      score: Math.max(0, ranked.score),
      index: close ? ranked.index : -1,
      question,
      answers: matched ? answers : [],
      msg
    }
  };
};

const handleAdd = (questions, body) => {
  const title = String(body.title || body.question || "").trim();
  const answers = normalizeAnswers(body.answers || body.answer);
  if (!title || !answers.length) {
    return { status: 400, payload: miss("title 和 answers 必填") };
  }
  const next = {
    title,
    no: body.no == null ? "" : String(body.no).trim(),
    type: body.type == null ? "" : String(body.type),
    options: Array.isArray(body.options) ? body.options.map((item) => String(item)) : [],
    answers
  };
  const existingIndex = questions.findIndex((item) => normalizeTitle(item.title) === normalizeTitle(title));
  const created = existingIndex < 0;
  if (created) {
    questions.push(next);
  } else {
    questions[existingIndex] = { ...questions[existingIndex], ...next };
  }
  saveQuestions(questions);
  return { status: 200, payload: ok(next.answers, questions.length, { created }) };
};

const importItems = (body) => {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.questions)) return body.questions;
  return [];
};

const handleImport = (questions, body) => {
  const items = importItems(body).filter((item) => item && typeof item === "object" && (item.title || item.question));
  if (!items.length) {
    return { status: 400, payload: miss("没有可导入的题目") };
  }
  let created = 0;
  let updated = 0;
  let skipped = 0;
  for (const item of items) {
    const result = handleAdd(questions, item);
    if (result.status !== 200) {
      skipped += 1;
      continue;
    }
    if (result.payload.created) created += 1;
    else updated += 1;
  }
  return {
    status: 200,
    payload: ok([], questions.length, {
      created,
      updated,
      skipped,
      msg: `导入完成：新增 ${created}，更新 ${updated}，跳过 ${skipped}`
    })
  };
};

const handleUpdate = (questions, body) => {
  const index = Number(body.index);
  if (!Number.isInteger(index) || index < 0 || index >= questions.length) {
    return { status: 400, payload: miss("需要有效 index") };
  }
  const title = String(body.title || body.question || "").trim();
  const answers = normalizeAnswers(body.answers || body.answer);
  if (!title || !answers.length) {
    return { status: 400, payload: miss("title 和 answers 必填") };
  }
  questions[index] = {
    title,
    no: body.no == null ? String(questions[index].no || "") : String(body.no).trim(),
    type: body.type == null ? "" : String(body.type),
    options: Array.isArray(body.options) ? body.options.map((item) => String(item)) : [],
    answers
  };
  saveQuestions(questions);
  return { status: 200, payload: ok(answers, questions.length) };
};

const handleDelete = (questions, body) => {
  const index = Number(body.index);
  const title = String(body.title || "").trim();
  if (Number.isInteger(index) && index >= 0 && index < questions.length) {
    questions.splice(index, 1);
  } else if (title) {
    const key = normalizeTitle(title);
    const next = questions.filter((item) => normalizeTitle(item.title) !== key);
    questions.length = 0;
    questions.push(...next);
  } else {
    return { status: 400, payload: miss("需要 title 或 index") };
  }
  saveQuestions(questions);
  return { status: 200, payload: ok([], questions.length) };
};

const route = async (req, res) => {
  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
  if (req.method === "OPTIONS") {
    json(res, 204, {});
    return;
  }
  if (req.method === "GET" && url.pathname === "/exam-parse.js") {
    res.writeHead(200, {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "no-store"
    });
    res.end(fs.readFileSync(path.join(path.dirname(ADMIN_FILE), "exam-parse.js")));
    return;
  }
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/admin")) {
    html(res, fs.readFileSync(ADMIN_FILE, "utf8"));
    return;
  }
  if (req.method === "GET" && url.pathname === "/template.json") {
    downloadJson(res, "areasong-question-template.json", TEMPLATE);
    return;
  }
  if (req.method === "GET" && url.pathname === "/health") {
    const questions = loadQuestions();
    json(res, 200, { ok: true, count: questions.length });
    return;
  }
  const questions = loadQuestions();
  if (req.method === "GET" && url.pathname === "/questions") {
    json(res, 200, questions);
    return;
  }
  if (req.method === "POST" && url.pathname === "/search") {
    const body = await readBody(req);
    json(res, 200, handleSearch(questions, body));
    return;
  }
  if (req.method === "POST" && url.pathname === "/probe") {
    const body = await readBody(req);
    const result = handleProbe(questions, body);
    json(res, result.status, result.payload);
    return;
  }
  if (req.method === "POST" && url.pathname === "/questions") {
    const body = await readBody(req);
    const result = handleAdd(questions, body);
    json(res, result.status, result.payload);
    return;
  }
  if (req.method === "PUT" && url.pathname === "/questions") {
    const body = await readBody(req);
    const result = handleUpdate(questions, body);
    json(res, result.status, result.payload);
    return;
  }
  if (req.method === "POST" && url.pathname === "/questions/import") {
    const body = await readBody(req);
    const result = handleImport(questions, body);
    json(res, result.status, result.payload);
    return;
  }
  if (req.method === "DELETE" && url.pathname === "/questions") {
    const body = await readBody(req);
    const result = handleDelete(questions, body);
    json(res, result.status, result.payload);
    return;
  }
  json(res, 404, miss("接口不存在"));
};

const server = http.createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (error) {
    json(res, 500, miss(error instanceof Error ? error.message : "服务出错"));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`本地题库已启动：http://${HOST}:${PORT}`);
  console.log(`管理页：http://${HOST}:${PORT}/`);
  console.log("搜题：POST /search");
  console.log("试搜：POST /probe");
  console.log("加题：POST /questions");
  console.log("检查：GET  /health");
  console.log(`题库文件：${DATA_FILE}`);
  if (ACCESS_KEY) {
    console.log("已启用 QUESTION_BANK_KEY，请求体需要带 key");
  }
});
