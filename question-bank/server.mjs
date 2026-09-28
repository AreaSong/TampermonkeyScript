import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT) || 8787;
const ACCESS_KEY = process.env.QUESTION_BANK_KEY || "";
const MATCH_THRESHOLD = 75;
const DATA_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "data", "questions.json");

const json = (res, status, payload) => {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, referer, u, t",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
  });
  res.end(body);
};

const miss = (msg) => ({
  code: 10003,
  data: { answer: [], num: "", usenum: "" },
  msg
});

const ok = (answers, total) => ({
  code: 200,
  data: {
    answer: answers,
    num: String(total),
    usenum: "1"
  },
  msg: "ok"
});

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

const findQuestion = (questions, title, type) => {
  const needle = normalizeTitle(title);
  if (!needle) return null;
  let best = null;
  let bestScore = -1;
  for (const item of questions) {
    const hay = normalizeTitle(item.title);
    if (!hay) continue;
    let score = scoreTitle(needle, hay);
    if (type && item.type != null && String(item.type) === String(type) && score >= MATCH_THRESHOLD) {
      score += 1;
    }
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return bestScore >= MATCH_THRESHOLD ? best : null;
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

const handleAdd = (questions, body) => {
  const title = String(body.title || body.question || "").trim();
  const answers = normalizeAnswers(body.answers || body.answer);
  if (!title || !answers.length) {
    return { status: 400, payload: miss("title 和 answers 必填") };
  }
  const next = {
    title,
    type: body.type == null ? "" : String(body.type),
    options: Array.isArray(body.options) ? body.options.map((item) => String(item)) : [],
    answers
  };
  const existingIndex = questions.findIndex((item) => normalizeTitle(item.title) === normalizeTitle(title));
  if (existingIndex >= 0) {
    questions[existingIndex] = { ...questions[existingIndex], ...next };
  } else {
    questions.push(next);
  }
  saveQuestions(questions);
  return { status: 200, payload: ok(next.answers, questions.length) };
};

const route = async (req, res) => {
  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
  if (req.method === "OPTIONS") {
    json(res, 204, {});
    return;
  }
  if (req.method === "GET" && url.pathname === "/health") {
    const questions = loadQuestions();
    json(res, 200, { ok: true, count: questions.length });
    return;
  }
  const questions = loadQuestions();
  if (req.method === "POST" && url.pathname === "/search") {
    const body = await readBody(req);
    json(res, 200, handleSearch(questions, body));
    return;
  }
  if (req.method === "POST" && url.pathname === "/questions") {
    const body = await readBody(req);
    const result = handleAdd(questions, body);
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
  console.log("搜题：POST /search");
  console.log("加题：POST /questions");
  console.log("检查：GET  /health");
  console.log(`题库文件：${DATA_FILE}`);
  if (ACCESS_KEY) {
    console.log("已启用 QUESTION_BANK_KEY，请求体需要带 key");
  }
});
