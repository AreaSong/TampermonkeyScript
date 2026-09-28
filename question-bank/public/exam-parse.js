const SECTION_TYPE = {
  单选题: "0",
  单选: "0",
  多选题: "1",
  多选: "1",
  填空题: "2",
  填空: "2",
  判断题: "3",
  判断: "3",
  简答题: "4",
  简答: "4",
  论述题: "4"
};

const JUDGE_MAP = {
  对: "正确",
  正确: "正确",
  错: "错误",
  错误: "错误"
};

const SAMPLE_TEXT = `单选题
1.绿色植物在光照下释放氧气，主要是因为
A、呼吸作用
B、光合作用
C、蒸腾作用
D、渗透作用
答案:B

多选题
1.下列属于可再生资源的是
A、煤炭
B、太阳能
C、风能
D、石油
答案:BC

判断题
1.地球绕太阳公转一周大约是一年
答案:对

填空题
1.中国的首都是（）
答案:北京

简答题
1.如何保持身体健康？
答案:规律饮食、坚持锻炼，早睡早起，定期体检。
`;

const isSection = (line) => SECTION_TYPE[line.replace(/[:：]\s*$/, "")] != null;
const isQuestionStart = (line) => /^\d+\s*[.、．]/.test(line);
const isOption = (line) => /^[A-Za-z]\s*[、.．]/.test(line);
const isAnswer = (line) => /^(答案|正确答案)\s*[:：]/.test(line);
const isAnalysis = (line) => /^(解析|答案解析)\s*[:：]/.test(line);

const lettersToAnswers = (raw, options) => {
  const compact = String(raw).replace(/[^A-Za-z]/g, "").toUpperCase();
  if (!compact || !options.length) return null;
  if (![...compact].every((letter) => letter.charCodeAt(0) - 65 < options.length)) return null;
  return [...compact].map((letter) => options[letter.charCodeAt(0) - 65]);
};

const parseBlock = (lines, sectionType) => {
  const titleParts = [];
  const options = [];
  let answerRaw = "";
  for (const raw of lines) {
    const line = String(raw).trim();
    if (!line || isAnalysis(line)) continue;
    if (isAnswer(line)) {
      answerRaw = line.replace(/^(答案|正确答案)\s*[:：]\s*/, "").trim();
      continue;
    }
    const option = line.match(/^([A-Za-z])\s*[、.．]\s*(.*)$/);
    if (option) {
      options.push(option[2].trim());
      continue;
    }
    if (!answerRaw) titleParts.push(line.replace(/^\d+\s*[.、．]\s*/, ""));
  }
  const title = titleParts.join("").trim();
  if (!title || !answerRaw) return null;

  const letterAnswers = lettersToAnswers(answerRaw, options);
  const judge = JUDGE_MAP[answerRaw.replace(/\s+/g, "")];
  let type = sectionType;
  let answers;
  let nextOptions = options;

  if (letterAnswers && letterAnswers.length) {
    type = letterAnswers.length > 1 ? "1" : "0";
    if (sectionType === "0" || sectionType === "1") type = sectionType;
    answers = letterAnswers;
  } else if (judge) {
    type = "3";
    nextOptions = ["正确", "错误"];
    answers = [judge];
  } else if (answerRaw.includes("|")) {
    type = "2";
    nextOptions = [];
    answers = answerRaw.split("|").map((item) => item.trim()).filter(Boolean);
  } else if (options.length >= 2) {
    type = sectionType === "1" ? "1" : "0";
    answers = [answerRaw];
  } else {
    type = sectionType === "2" ? "2" : "4";
    nextOptions = [];
    answers = type === "2"
      ? answerRaw.split("|").map((item) => item.trim()).filter(Boolean)
      : [answerRaw];
  }
  return { title, type, options: nextOptions, answers };
};

const parseExamText = (text) => {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const questions = [];
  let sectionType = "";
  let current = [];
  const flush = () => {
    if (!current.length) return;
    const item = parseBlock(current, sectionType);
    if (item) questions.push(item);
    current = [];
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && isSection(trimmed) && !isQuestionStart(trimmed) && !isOption(trimmed)) {
      flush();
      sectionType = SECTION_TYPE[trimmed.replace(/[:：]\s*$/, "")];
      continue;
    }
    if (trimmed && isQuestionStart(trimmed) && current.some((item) => String(item).trim())) flush();
    current.push(line);
  }
  flush();
  return questions;
};

globalThis.ExamParse = { parseExamText, SAMPLE_TEXT };
