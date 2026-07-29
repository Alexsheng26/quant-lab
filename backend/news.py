"""
新闻 Agent —— 资讯扫描 + 基于新闻的检索问答
============================================

两件事：

1. **抓资讯**。来源是 Yahoo Finance（经 yfinance），每只股约 10 条，
   带标题、摘要、时间、媒体、原文链接。再按情绪词典给每条打分，
   聚合出一个整体情绪倾向。

2. **基于新闻的问答**。这里做的是**检索式**问答（BM25 风格的词频打分 +
   原文片段返回），不是生成式。没有接 LLM 的情况下如实说明这一点，
   总比拿模板句冒充"AI 总结"强。

   想升级成真正的 RAG：把 `answer()` 里检索到的片段丢给 Claude API
   （见 ANSWER_WITH_LLM 注释处），检索层不用动。

**关于"粉碎信息茧房"**：单一来源本身就是茧房。这里的做法是把每条新闻的
媒体来源标出来，并统计来源分布——用户能一眼看到自己读的是不是同一家的口径。
后续接入更多 RSS 源可以在 fetch() 里扩展。
"""

from __future__ import annotations

import math
import re
import time
from collections import Counter
from typing import Any, Dict, List

# ----------------------------------------------------------------------
# 情绪词典（金融语境，非通用情感）
# ----------------------------------------------------------------------
POSITIVE = {
    "beat": 2, "beats": 2, "surge": 2, "surges": 2, "soar": 2, "soars": 2,
    "rally": 2, "record": 2, "outperform": 2, "upgrade": 2, "upgraded": 2,
    "raise": 1, "raised": 1, "raises": 1, "growth": 1, "profit": 1, "gain": 1,
    "gains": 1, "strong": 1, "bullish": 2, "buy": 1, "expand": 1, "expands": 1,
    "boost": 1, "boosts": 1, "top": 1, "tops": 1, "win": 1, "wins": 1,
    "approval": 1, "approved": 1, "breakthrough": 2, "partnership": 1,
    "dividend": 1, "buyback": 2, "高于预期": 2, "增长": 1, "创新高": 2, "上调": 1,
}
NEGATIVE = {
    "miss": -2, "misses": -2, "missed": -2, "plunge": -2, "plunges": -2,
    "slump": -2, "slumps": -2, "fall": -1, "falls": -1, "drop": -1, "drops": -1,
    "downgrade": -2, "downgraded": -2, "cut": -1, "cuts": -1, "loss": -2,
    "losses": -2, "weak": -1, "bearish": -2, "sell": -1, "lawsuit": -2,
    "probe": -2, "investigation": -2, "recall": -2, "layoff": -2, "layoffs": -2,
    "warning": -1, "warns": -1, "decline": -1, "declines": -1, "risk": -1,
    "fraud": -3, "delay": -1, "delayed": -1, "低于预期": -2, "下跌": -1,
    "亏损": -2, "下调": -1, "调查": -2,
}

WORD_RE = re.compile(r"[a-z]+|[一-鿿]{2,4}")
STOPWORDS = {
    "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "are",
    "was", "were", "be", "been", "as", "at", "by", "it", "its", "this", "that",
    "with", "from", "has", "have", "will", "s", "t",
}


def tokenize(text: str) -> List[str]:
    return [w for w in WORD_RE.findall((text or "").lower()) if w not in STOPWORDS]


def score_sentiment(text: str) -> int:
    """返回情绪原始分；正数偏多、负数偏空。"""
    words = tokenize(text)
    s = 0
    for w in words:
        s += POSITIVE.get(w, 0) + NEGATIVE.get(w, 0)
    # 中文关键词是多字的，正则切不出来，直接子串命中
    low = (text or "").lower()
    for k, v in list(POSITIVE.items()) + list(NEGATIVE.items()):
        if len(k) > 1 and not k.isascii() and k in low:
            s += v
    return s


def sentiment_label(score: int) -> str:
    if score >= 3:
        return "偏多"
    if score <= -3:
        return "偏空"
    return "中性"


# ----------------------------------------------------------------------
# 抓取
# ----------------------------------------------------------------------
def _unwrap(item: Dict[str, Any]) -> Dict[str, Any]:
    """yfinance 新版把字段套在 content 里，兼容两种结构。"""
    return item.get("content") if isinstance(item.get("content"), dict) else item


def fetch(symbol: str, limit: int = 20) -> Dict[str, Any]:
    try:
        import yfinance as yf
    except ImportError:
        return {"symbol": symbol, "items": [], "error": "yfinance 未安装"}

    try:
        raw = yf.Ticker(symbol).news or []
    except Exception as exc:                          # noqa: BLE001
        return {"symbol": symbol, "items": [], "error": f"{type(exc).__name__}: {exc}"}

    items: List[Dict[str, Any]] = []
    for it in raw[:limit]:
        c = _unwrap(it)
        title = c.get("title") or ""
        summary = c.get("summary") or c.get("description") or ""
        provider = c.get("provider") or {}
        prov_name = provider.get("displayName") if isinstance(provider, dict) else str(provider)

        url = ""
        cu = c.get("canonicalUrl") or c.get("clickThroughUrl")
        if isinstance(cu, dict):
            url = cu.get("url", "")
        elif isinstance(cu, str):
            url = cu
        url = url or c.get("link", "")

        s = score_sentiment(title + " " + summary)
        items.append({
            "id": it.get("id") or c.get("id") or url,
            "title": title,
            "summary": summary[:400],
            "publisher": prov_name or "未知来源",
            "published": c.get("pubDate") or c.get("displayTime") or "",
            "url": url,
            "sentiment": s,
            "sentimentLabel": sentiment_label(s),
        })

    total = sum(i["sentiment"] for i in items)
    sources = Counter(i["publisher"] for i in items)
    pos = sum(1 for i in items if i["sentiment"] >= 3)
    neg = sum(1 for i in items if i["sentiment"] <= -3)

    return {
        "symbol": symbol,
        "count": len(items),
        "items": items,
        "overall": {
            "score": total,
            "label": sentiment_label(total),
            "positive": pos,
            "negative": neg,
            "neutral": len(items) - pos - neg,
        },
        # 来源分布：单一来源占比过高就是信息茧房，直接把数字摆出来
        "sources": [{"name": k, "count": v} for k, v in sources.most_common()],
        "fetchedAt": int(time.time()),
    }


# ----------------------------------------------------------------------
# 检索式问答
# ----------------------------------------------------------------------
def answer(symbol: str, question: str, limit: int = 20,
           use_llm: bool = True) -> Dict[str, Any]:
    """
    在该股新闻语料里检索与问题最相关的片段。

    用的是 TF-IDF 余弦近似（语料只有十几篇，没必要上向量库）。
    返回的是**原文片段 + 出处**，不做生成式改写——没有 LLM 时
    编一段通顺的话反而会让人以为是模型的结论。
    """
    corpus = fetch(symbol, limit)
    items = corpus.get("items", [])
    if not items:
        return {"symbol": symbol, "question": question, "hits": [],
                "answer": "没有抓到这只标的的新闻，无法回答。",
                "mode": "retrieval", "sources": []}

    docs = [tokenize(i["title"] + " " + i["summary"]) for i in items]
    q_terms = tokenize(question)
    if not q_terms:
        return {"symbol": symbol, "question": question, "hits": [],
                "answer": "问题里没有可检索的关键词。", "mode": "retrieval", "sources": []}

    n = len(docs)
    df = Counter()
    for d in docs:
        for w in set(d):
            df[w] += 1

    scored = []
    for idx, d in enumerate(docs):
        tf = Counter(d)
        length = max(1, len(d))
        s = 0.0
        for t in q_terms:
            if tf[t]:
                idf = math.log((n + 1) / (df[t] + 0.5))
                s += (tf[t] / length) * idf
        if s > 0:
            scored.append((s, idx))

    scored.sort(reverse=True)
    hits = [{
        "score": round(s, 4),
        "title": items[i]["title"],
        "summary": items[i]["summary"],
        "publisher": items[i]["publisher"],
        "published": items[i]["published"],
        "url": items[i]["url"],
        "sentimentLabel": items[i]["sentimentLabel"],
    } for s, i in scored[:5]]

    if not hits:
        return {
            "symbol": symbol, "question": question,
            "answer": f"这 {len(items)} 条新闻里没有匹配「{question}」的内容。换个关键词试试。",
            "hits": [], "mode": "retrieval", "corpusSize": len(items),
        }

    srcs = sorted({h["publisher"] for h in hits})
    result = {
        "symbol": symbol,
        "question": question,
        "answer": (f"在 {len(items)} 条新闻中找到 {len(hits)} 条相关报道，"
                   f"来自 {'、'.join(srcs)}。以下是原文片段，请自行核对原始链接。"),
        "hits": hits,
        "mode": "retrieval",
        "corpusSize": len(items),
    }

    # 配了 ANTHROPIC_API_KEY 就把检索结果交给 Claude 综合成带出处的回答；
    # 没配、或调用失败，就保留上面的检索式结果 —— 功能降级但不报错。
    if not use_llm:
        return result                     # 被限流时只走检索，不消耗额度

    try:
        import llm
        if llm.available():
            gen = llm.answer_from_news(symbol, question, hits)
            if gen.get("ok"):
                result.update({
                    "mode": "generative",
                    "answer": gen["answer"],
                    "cited": gen.get("cited", []),
                    "confidence": gen.get("confidence"),
                    "caveat": gen.get("caveat", ""),
                    "model": gen.get("model"),
                    "usage": gen.get("usage"),
                })
            else:
                result["llmError"] = gen.get("reason")
    except Exception as exc:                          # noqa: BLE001
        result["llmError"] = f"{type(exc).__name__}: {exc}"

    return result
