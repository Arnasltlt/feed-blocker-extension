#!/usr/bin/env python3
"""
Local helper server that groups YouTube recommendations via Groq.

Expose POST /rerank
Body: {"videos": [{"title": "...", "url": "...", "channel": "..."}]}
Response: {"groups": [{"category": "...", "videos": [{"title": "...", "url": "..."}]}]}
"""

from __future__ import annotations

import sys

sys.dont_write_bytecode = True

import json
import logging
import os
import re
import time
from datetime import datetime, timezone
from typing import Any, Dict, List

import requests
from flask import Flask, jsonify, request
from flask_cors import CORS

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("custom_feed")

GROQ_API_KEY = os.environ.get("GROQ_API_KEY")
GROQ_MODEL = os.environ.get("GROQ_MODEL", "openai/gpt-oss-20b")
OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY")
OPENROUTER_SUMMARY_MODEL = os.environ.get("OPENROUTER_SUMMARY_MODEL", "google/gemini-3.1-flash-lite-preview")
MAX_VIDEOS = max(1, int(os.environ.get("CUSTOM_FEED_MAX_VIDEOS", "30")))
SERVER_PORT = int(os.environ.get("CUSTOM_FEED_SERVER_PORT", "11400"))
GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions"
OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions"
MAX_TITLE_CHARS = 180
MAX_AUTHOR_CHARS = 80
MAX_CHANNEL_CHARS = 80
ALLOWED_SUMMARY_MODELS = {
    "google/gemini-3.1-flash-lite-preview",
    "google/gemini-3-flash-preview",
}

GROUP_RESPONSE_SCHEMA = {
    "name": "grouped_video_feed",
    "schema": {
        "type": "object",
        "properties": {
            "groups": {
                "type": "array",
                "minItems": 1,
                "maxItems": 6,
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "category": {"type": "string"},
                        "videos": {
                            "type": "array",
                            "minItems": 1,
                            "maxItems": 10,
                            "items": {
                                "type": "object",
                                "additionalProperties": False,
                                "properties": {
                                    "title": {"type": "string"},
                                    "url": {"type": "string", "pattern": "^https?://"}
                                },
                                "required": ["title", "url"]
                            }
                        }
                    },
                    "required": ["category", "videos"]
                }
            }
        },
        "required": ["groups"],
        "additionalProperties": False
    }
}

SYSTEM_PROMPT = (
    "You are a JSON-only assistant that groups YouTube recommendations by learning-focused themes. "
    'You must respond with valid JSON that matches exactly this schema: {"groups":[{"category":string,"videos":[{"title":string,"url":string}]}]}. '
    "After any internal reasoning, your assistant message content must contain only that JSON object—never leave the content empty. "
    "Never include markdown, explanations, code fences, or extra fields. "
    "Only reference the videos provided to you—never invent new URLs or titles. "
    "Favor tutorials, explainers, long-form breakdowns, courses, research recaps, and other learning-focused content."
)

USER_INSTRUCTIONS = (
    "Group every provided video into learning-focused categories using these rules:\n"
    "1. Choose clear category labels (e.g., 'Programming Deep Dives', 'Mindset & Strategy', 'Quick Inspiration').\n"
    "2. Prefer grouping tutorials, walkthroughs, explainers, courses, and research recaps together.\n"
    "3. Deprioritize shorts, drama, gossip, or clickbait by placing them in lower-value categories near the end.\n"
    "4. Include every video exactly once in some group. If a video does not fit any high-value group, place it in a catch-all 'Other' style section.\n"
    "Limit yourself to at most six categories, each containing at most ten videos. "
    "Return the grouped structure strictly as JSON following the required schema."
)

# Summary endpoint schema and prompts
SUMMARY_RESPONSE_SCHEMA = {
    "name": "feed_summary",
    "schema": {
        "type": "object",
        "properties": {
            "topics": {
                "type": "array",
                "minItems": 1,
                "maxItems": 5,
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "title": {"type": "string"},
                        "summary": {"type": "string"},
                        "citations": {
                            "type": "array",
                            "minItems": 1,
                            "maxItems": 5,
                            "items": {
                                "type": "object",
                                "additionalProperties": False,
                                "properties": {
                                    "quote": {"type": "string"},
                                    "attribution": {"type": "string"}
                                },
                                "required": ["quote", "attribution"]
                            }
                        }
                    },
                    "required": ["title", "summary", "citations"]
                }
            }
        },
        "required": ["topics"],
        "additionalProperties": False
    }
}

# Tier 1 brief schema — cluster + title + one-liner only.
# Deep prose (summary, why_it_matters, tension, takeaways) is Tier 2 (Explore agent).
OPENROUTER_SUMMARY_PAGE_SCHEMA = {
    "name": "feed_brief_page",
    "schema": {
        "type": "object",
        "properties": {
            "overview": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "headline": {"type": "string"},
                },
                "required": ["headline"],
            },
            "topics": {
                "type": "array",
                "minItems": 1,
                "maxItems": 5,
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "title": {"type": "string"},
                        "one_liner": {"type": "string"},
                        "item_urls": {
                            "type": "array",
                            "maxItems": 10,
                            "items": {"type": "string"},
                        },
                        "citations": {
                            "type": "array",
                            "maxItems": 2,
                            "items": {
                                "type": "object",
                                "additionalProperties": False,
                                "properties": {
                                    "quote": {"type": "string"},
                                    "attribution": {"type": "string"},
                                },
                                "required": ["quote", "attribution"],
                            },
                        },
                    },
                    "required": ["title", "one_liner", "item_urls", "citations"],
                },
            },
        },
        "required": ["overview", "topics"],
        "additionalProperties": False,
    },
}

OPENROUTER_SUMMARY_SYSTEM_PROMPT = (
    "You are a Tier 1 feed brief — a fast signal detector, not a writer. "
    "Your only job: look at scored feed items and identify what has shifted — things you would feel like you missed if you were offline. "
    "A valid topic is anything that represents a moment: a release, a leak, a viral thread everyone is responding to, "
    "a surprising data point, a person doing something notable, a product people are suddenly trying. "
    "The question to ask for each cluster: would someone feel like they missed something if they didn't see this? "
    "Noise is: generic advice, hot takes with no event behind them, motivation content, listicles, predictions without news, "
    "entertainment, and commentary that isn't orbiting a specific moment. "
    "When distinct named events or products appear, keep them as separate topics. "
    "If everything in the feed is noise, return an empty topics array. "
    "Never invent facts, URLs, or attributions. Return only valid JSON."
)

OPENROUTER_SUMMARY_USER_INSTRUCTIONS = (
    "Given these feed items (numbered, with Priority score — higher = stronger concrete signal), "
    "cluster them into 2-5 topics. Items with Priority < 0 are noise — skip them.\n\n"
    "Hard rules:\n"
    "- A topic requires at least 2 distinct items. Never create a topic from a single post or tweet.\n"
    "- Skip entertainment, wildlife, sports highlights, memes, and personal anecdotes — these are never topics.\n"
    "- Skip topics where all items are from a single author with no cross-post signal.\n\n"
    "For each topic return:\n"
    "- title: name the actual event, product, or story (not a category label)\n"
    "- one_liner: one crisp sentence. Lead with what changed or shipped. "
    "Good: 'Llama 4 ships with a 10M context window and open weights.' "
    "Bad: 'AI developments are circulating in your feed.'\n"
    "- item_urls: URLs of items that belong to this cluster\n"
    "- citations: 1-2 direct quotes with attribution from item titles or detail text. Never invent.\n\n"
    "overview.headline: one sentence naming the strongest development across all topics.\n\n"
    "Return topics strongest-first. If no items clear the noise bar, return an empty topics array."
)

MAX_SUMMARY_ITEMS = 100

app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}})

MIN_REQUEST_INTERVAL_SEC = 10
SUMMARY_REQUEST_INTERVAL_SEC = 30
MAX_CACHE_ENTRIES = 100
rerank_result_cache: Dict[str, Dict[str, Any]] = {}
summary_result_cache: Dict[str, Dict[str, Any]] = {}

WORD_RE = re.compile(r"[A-Za-z][A-Za-z0-9'+-]{2,}")
STOP_WORDS = {
    "about", "after", "again", "amid", "and", "are", "but", "can", "for", "from", "has",
    "have", "into", "its", "just", "more", "not", "now", "off", "out", "over", "really",
    "still", "that", "the", "their", "this", "through", "what", "when", "with", "your",
}
GENERIC_TOPIC_WORDS = {
    "youtube", "twitter", "linkedin", "tweet", "post", "thread", "video", "watch", "today",
    "latest", "new", "here", "there", "about", "from", "into", "using", "used", "says",
    "just", "really", "thing", "things", "people", "after", "before", "your", "home",
    "feed", "breaking", "update", "updates", "talk", "shows", "show", "reaction", "reacts",
    "open", "free", "email", "users", "user", "built", "make", "made", "app", "you", "want",
    "along", "best", "day", "four", "matters",
}
LOW_SIGNAL_TEXTS = {
    "true",
    "yes me too",
    "i m serious",
    "nobody ever listens",
}
SUMMARY_STRONG_NEWS_PHRASES = {
    "launch",
    "launched",
    "launches",
    "launching",
    "release",
    "released",
    "releases",
    "shipping",
    "shipped",
    "ships",
    "rollout",
    "rolling out",
    "announce",
    "announced",
    "announces",
    "announcement",
    "unveil",
    "unveiled",
    "unveils",
    "leak",
    "leaked",
    "acquire",
    "acquired",
    "acquires",
    "acquisition",
    "buy",
    "buys",
    "raise",
    "raised",
    "funding",
    "preview",
    "beta",
    "general availability",
    "ga",
    "benchmark",
    "breakthrough",
    "official broadcast",
    "mission coverage",
    "first crewed",
    "daily logbook",
    "outage",
    "incident",
    "exploit",
    "vulnerability",
    "lawsuit",
    "ruling",
    "policy",
    "approved",
    "approval",
}
SUMMARY_MEDIUM_NEWS_PHRASES = {
    "update",
    "updates",
    "roadmap",
    "report",
    "reported",
    "coverage",
    "recap",
    "comparison",
    "behind the scenes",
    "what happened",
    "why it matters",
    "mission",
    "crew",
    "orbit",
    "moon",
    "spacecraft",
    "orion",
    "artifact",
    "infrastructure",
    "open source",
    "model",
    "models",
    "agent",
    "agents",
}
SUMMARY_PRIORITY_TERMS = {
    "openai",
    "anthropic",
    "claude",
    "gemma",
    "gpt",
    "cursor",
    "openclaw",
    "codex",
    "llm",
    "llama",
    "nasa",
    "artemis",
    "orion",
    "spacex",
    "microsoft",
    "google",
    "tbpn",
    "turing",
    "linkedin",
}
SUMMARY_EXCLUDED_PHRASES = {
    "lofi",
    "lo-fi",
    "jazzhop",
    "playlist",
    "mix -",
    "full scene",
    "trailer",
    "soundtrack",
    "concert",
    "sympathy",
    "symphony",
    "ambience",
    "ambient",
    "relaxing",
    "relax",
    "cozy cafe",
    "study music",
    "beautiful music",
    "harry potter",
    "disney",
    "hbo max",
    "snl",
    "episode",
    "movie",
    "music",
    "game highlights",
    "cold open",
    "radio",
}
SUMMARY_DOWNRANK_PHRASES = {
    "deep work",
    "focus",
    "workflow",
    "routine",
    "tips",
    "guide",
    "career advice",
    "mindset",
    "motivation",
    "inspiration",
    "podcast",
    "interview",
    "reaction",
    "my thoughts",
    "hot take",
    "prediction",
    "predictions",
    "will win",
    "future of",
}
OFFICIAL_SOURCE_HINTS = {
    "official",
    "nasa",
    "openai",
    "google",
    "anthropic",
    "company",
    "broadcast",
}
PHRASE_TOKEN_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9.+-]*")
PHRASE_STOP_WORDS = STOP_WORDS | GENERIC_TOPIC_WORDS | {
    "official",
    "broadcast",
    "coverage",
    "video",
    "videos",
    "mission",
    "crew",
    "people",
    "daily",
    "live",
}
ROMAN_NUMERALS = {"ii", "iii", "iv", "vi", "vii", "viii", "ix", "x"}
VIDEO_TOPIC_RULES = [
    ("AI & Programming", ("ai", "claude", "gpt", "openai", "agent", "coding", "code", "developer", "workflow", "python", "software", "model")),
    ("Space & Science", ("nasa", "space", "moon", "artemis", "orion", "rocket", "starship", "science")),
    ("Business & Strategy", ("business", "ceo", "startup", "money", "market", "sales", "strategy")),
    ("History & Culture", ("history", "archive", "bbc", "documentary", "classic")),
    ("Media & Entertainment", ("trailer", "music", "movie", "series", "episode", "reaction")),
]
TOPIC_STYLE_MAP = {
    "trend": "high-momentum",
    "debate": "contested",
    "breakthrough": "new development",
    "deep_dive": "substantive",
    "niche": "niche but relevant",
}


def create_video_hash(videos: List[Dict[str, Any]]) -> str:
    """Create a hash from video URLs for caching/rate limiting."""
    if not videos:
        return ""
    urls = sorted([str(v.get("url", "")).strip() for v in videos if v.get("url")])
    return "|".join(urls)


def clean_text(value: Any, max_length: int) -> str:
    text = str(value or "")
    text = "".join(ch if ch >= " " or ch in "\n\r\t" else " " for ch in text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:max_length]


def normalize_text_for_key(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(value or "").lower()).strip()


def tokenize_topic_text(value: Any) -> List[str]:
    tokens = []
    for token in WORD_RE.findall(str(value or "").lower()):
        if token in STOP_WORDS or token in GENERIC_TOPIC_WORDS:
            continue
        tokens.append(token)
    return tokens


def is_low_signal_item(title: str, full_text: str) -> bool:
    normalized_title = normalize_text_for_key(title)
    normalized_text = normalize_text_for_key(full_text or title)
    word_count = len(normalized_text.split())

    if normalized_title in LOW_SIGNAL_TEXTS:
        return True
    if word_count <= 2 and len(normalized_text) < 20:
        return True
    if word_count <= 4 and len(normalized_text) < 28 and not re.search(r"\d", normalized_text):
        return True
    return False


def contains_any_phrase(text: str, phrases: set[str]) -> bool:
    lowered = text.lower()
    return any(phrase in lowered for phrase in phrases)


def compute_item_priority_score(item: Dict[str, Any]) -> float:
    text = " ".join(
        part for part in [
            str(item.get("title") or ""),
            str(item.get("full_text") or ""),
            str(item.get("context") or ""),
            str(item.get("author") or ""),
        ]
        if part
    ).lower()

    score = 0.0
    score += 2.8 if contains_any_phrase(text, SUMMARY_STRONG_NEWS_PHRASES) else 0.0
    score += 0.9 if contains_any_phrase(text, SUMMARY_MEDIUM_NEWS_PHRASES) else 0.0
    score += 0.7 if contains_any_phrase(text, SUMMARY_PRIORITY_TERMS) else 0.0
    score += 0.4 if contains_any_phrase(text, OFFICIAL_SOURCE_HINTS) else 0.0
    score -= 4.0 if contains_any_phrase(text, SUMMARY_EXCLUDED_PHRASES) else 0.0
    score -= 1.2 if contains_any_phrase(text, SUMMARY_DOWNRANK_PHRASES) else 0.0
    score -= 1.5 if "promoted" in text or "follow" in text or "view all recommendations" in text else 0.0
    score -= 0.8 if "why " in text and not contains_any_phrase(text, SUMMARY_STRONG_NEWS_PHRASES) else 0.0
    return round(score, 2)


def should_exclude_from_summary(item: Dict[str, Any]) -> bool:
    text = " ".join(
        part for part in [
            str(item.get("title") or ""),
            str(item.get("full_text") or ""),
            str(item.get("context") or ""),
        ]
        if part
    ).lower()
    if contains_any_phrase(text, SUMMARY_EXCLUDED_PHRASES):
        return True
    return float(item.get("priority_score") or 0.0) <= -2.0


def find_rule_category(text: str, rules: List[tuple[str, tuple[str, ...]]], fallback: str) -> str:
    lowered = text.lower()
    for label, keywords in rules:
      if any(keyword in lowered for keyword in keywords):
          return label
    return fallback


def build_keyword_summary(items: List[Dict[str, Any]], fallback_label: str) -> str:
    counts: Dict[str, int] = {}
    for item in items:
        for token in WORD_RE.findall(item.get("title", "").lower()):
            if token in STOP_WORDS:
                continue
            counts[token] = counts.get(token, 0) + 1
    top_terms = [term for term, _ in sorted(counts.items(), key=lambda pair: (-pair[1], pair[0]))[:3]]
    if not top_terms:
        return fallback_label
    return ", ".join(top_terms)


def normalize_videos(videos: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    normalized: List[Dict[str, Any]] = []
    for entry in videos:
        if not isinstance(entry, dict):
            continue
        title = clean_text(entry.get("title") or entry.get("text"), MAX_TITLE_CHARS)
        url = str(entry.get("url") or entry.get("href") or "").strip()
        channel = clean_text(entry.get("channel"), MAX_CHANNEL_CHARS)
        if not title or not url:
            continue
        normalized.append(
            {
                "title": title,
                "url": url,
                "channel": channel,
                "position": len(normalized),
            }
        )
        if len(normalized) >= MAX_VIDEOS:
            break
    return normalized


def format_video_list(videos: List[Dict[str, Any]]) -> str:
    lines = []
    for video in videos:
        channel = video.get("channel") or "Unknown channel"
        position = video.get("position", 0) + 1
        lines.append(
            f"{position}. Title: {video['title']} | Channel: {channel} | URL: {video['url']}"
        )
    return "\n".join(lines)


def strip_code_fences(text: str) -> str:
    trimmed = (text or "").strip()
    if trimmed.startswith("```"):
        trimmed = trimmed.split("```", 1)[1]
        trimmed = trimmed.split("```", 1)[0]
    return trimmed.strip()


def sanitize_grouped_response(
    candidate_groups: Any, allowed: List[Dict[str, Any]]
) -> List[Dict[str, Any]]:
    if not isinstance(candidate_groups, list):
        return [{"category": "All videos", "videos": allowed}]

    allowed_by_url: Dict[str, Dict[str, Any]] = {video["url"]: video for video in allowed}
    assigned_urls = set()
    sanitized: List[Dict[str, Any]] = []

    for group in candidate_groups:
        if not isinstance(group, dict):
            continue
        category = str(group.get("category") or "").strip()
        if not category:
            continue
        videos = []
        for item in group.get("videos", []):
            if not isinstance(item, dict):
                continue
            url = str(item.get("url") or "").strip()
            if not url or url not in allowed_by_url or url in assigned_urls:
                continue
            base = allowed_by_url[url]
            videos.append(
                {
                    "title": base["title"],
                    "url": base["url"],
                    "channel": base.get("channel", ""),
                    "position": base.get("position", 0),
                }
            )
            assigned_urls.add(url)
        if videos:
            sanitized.append({"category": category[:80], "videos": videos})

    # Add any unassigned videos to a catch-all group
    remaining = [
        {
            "title": video["title"],
            "url": video["url"],
            "channel": video.get("channel", ""),
            "position": video.get("position", 0),
        }
        for video in allowed
        if video["url"] not in assigned_urls
    ]
    if remaining:
        sanitized.append({"category": "Other picks", "videos": remaining})

    if not sanitized:
        sanitized.append({"category": "All videos", "videos": allowed})

    return sanitized


def is_default_grouping(groups: List[Dict[str, Any]], videos: List[Dict[str, Any]]) -> bool:
    """Detect the catch-all fallback grouping used when reranking fails."""
    if not isinstance(groups, list) or len(groups) != 1:
        return False
    group = groups[0]
    if not isinstance(group, dict):
        return False
    category = str(group.get("category") or "").strip().lower()
    if category not in {"all videos", "all video", "all"}:
        return False
    grouped_videos = group.get("videos")
    if not isinstance(grouped_videos, list) or len(grouped_videos) != len(videos):
        return False
    grouped_urls = [str(video.get("url") or "").strip() for video in grouped_videos]
    source_urls = [str(video.get("url") or "").strip() for video in videos]
    return grouped_urls == source_urls


def get_cached_result(
    cache: Dict[str, Dict[str, Any]], cache_key: str, cooldown_seconds: int
) -> Any | None:
    cached_entry = cache.get(cache_key)
    if not cached_entry:
        return None

    age = time.time() - float(cached_entry.get("timestamp", 0))
    if age >= cooldown_seconds:
        return None

    return cached_entry.get("payload")


def set_cached_result(
    cache: Dict[str, Dict[str, Any]], cache_key: str, payload: Any
) -> None:
    cache[cache_key] = {
        "timestamp": time.time(),
        "payload": payload,
    }

    if len(cache) <= MAX_CACHE_ENTRIES:
        return

    oldest_key = min(cache.items(), key=lambda item: float(item[1].get("timestamp", 0)))[0]
    del cache[oldest_key]


def normalize_feed_items(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Normalize and deduplicate feed items from multiple platforms."""
    normalized: List[Dict[str, Any]] = []
    seen_fingerprints = set()
    
    for entry in items:
        if not isinstance(entry, dict):
            continue
        title = clean_text(entry.get("title") or entry.get("text"), MAX_TITLE_CHARS)
        platform = str(entry.get("platform") or "").strip()
        author = clean_text(entry.get("channel") or entry.get("author"), MAX_AUTHOR_CHARS)
        full_text = clean_text(entry.get("full_text") or entry.get("fullText"), 420)
        context = clean_text(entry.get("context"), 140)
        url = str(entry.get("url") or "").strip()
        captured_at = clean_text(entry.get("captured_at"), 60)
        summary_text = clean_text("\n".join(part for part in [title, full_text, context] if part), 520)
        
        if not title or is_low_signal_item(title, full_text):
            continue

        fingerprint = url or f"{platform}|{author}|{normalize_text_for_key(full_text or title)}"
        if fingerprint in seen_fingerprints:
            continue

        seen_fingerprints.add(fingerprint)
        priority_score = compute_item_priority_score({
            "title": title,
            "author": author,
            "full_text": full_text,
            "context": context,
        })
        engagement = {}
        for field in ("viewCount", "likeCount", "retweetCount", "replyCount", "reactionCount", "commentCount"):
            val = clean_text(entry.get(field), 30)
            if val:
                engagement[field] = val

        normalized.append({
            "title": title,
            "platform": platform,
            "author": author,
            "url": url,
            "full_text": full_text,
            "context": context,
            "summary_text": summary_text,
            "captured_at": captured_at,
            "priority_score": priority_score,
            "engagement": engagement,
        })

        if len(normalized) >= MAX_SUMMARY_ITEMS:
            break

    return normalized


def format_feed_items(items: List[Dict[str, Any]]) -> str:
    """Format feed items for the summary prompt."""
    lines = []
    for idx, item in enumerate(items, 1):
        platform = item.get("platform") or "unknown"
        author = item.get("author") or "Unknown"
        url = item.get("url") or ""
        detail = item.get("full_text") or ""
        context = item.get("context") or ""
        captured_at = item.get("captured_at") or ""
        engagement = item.get("engagement") or {}
        engagement_parts = []
        if engagement.get("viewCount"):
            engagement_parts.append(engagement["viewCount"])
        for key in ("likeCount", "retweetCount", "reactionCount"):
            if engagement.get(key):
                engagement_parts.append(f"{engagement[key]} {key.replace('Count','s')}")
        engagement_str = " | Engagement: " + ", ".join(engagement_parts) if engagement_parts else ""
        lines.append(
            f"{idx}. [{platform.upper()}] Title: {item['title']} | Source: {author} | Context: {context} | "
            f"Detail: {detail} | Priority: {item.get('priority_score', 0)}{engagement_str} | Captured: {captured_at} | URL: {url}".strip()
        )
    return "\n".join(lines)


def create_item_hash(items: List[Dict[str, Any]]) -> str:
    """Create a hash from feed items for caching/rate limiting."""
    if not items:
        return ""
    titles = sorted(
        [
            str(item.get("url") or item.get("summary_text") or item.get("title") or "").strip()
            for item in items
            if item.get("title")
        ]
    )
    return "|".join(titles[:50])  # Use first 50 titles for hash


def groq_chat_completion(
    messages: List[Dict[str, str]],
    *,
    temperature: float,
    response_schema: Dict[str, Any] | None,
    max_tokens: int,
) -> tuple[Dict[str, Any] | None, str | None]:
    payload: Dict[str, Any] = {
        "model": GROQ_MODEL,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    if response_schema is not None:
        payload["response_format"] = {
            "type": "json_schema",
            "json_schema": response_schema,
        }
    else:
        payload["response_format"] = {"type": "json_object"}

    try:
        response = requests.post(
            GROQ_API_URL,
            headers={
                "Authorization": f"Bearer {GROQ_API_KEY}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=30,
        )
    except requests.RequestException as exc:
        logger.error("Groq request failed: %s", exc)
        return None, None

    if not response.ok:
        logger.error("Groq API error (status %d): %s", response.status_code, response.text)
        return None, response.text

    completion = response.json()
    choice = completion.get("choices", [{}])[0] or {}
    message = (choice.get("message") or {}).get("content") or ""
    if not message.strip():
        logger.error("Groq returned empty content: %s", json.dumps(completion)[:800])
        return None, None

    try:
        return json.loads(strip_code_fences(message)), None
    except json.JSONDecodeError:
        logger.error("Unable to parse Groq response as JSON: %s", message)
        return None, None


def openrouter_chat_completion(
    messages: List[Dict[str, str]],
    *,
    model: str,
    temperature: float,
    response_schema: Dict[str, Any] | None,
    max_tokens: int,
) -> tuple[Dict[str, Any] | None, str | None]:
    payload: Dict[str, Any] = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    if response_schema is not None:
        payload["response_format"] = {
            "type": "json_schema",
            "json_schema": response_schema,
        }
    else:
        payload["response_format"] = {"type": "json_object"}

    try:
        response = requests.post(
            OPENROUTER_API_URL,
            headers={
                "Authorization": f"Bearer {OPENROUTER_API_KEY}",
                "Content-Type": "application/json",
                "HTTP-Referer": "https://feed-blocking-server.fly.dev",
                "X-Title": "Focus Feed Brief",
            },
            json=payload,
            timeout=45,
        )
    except requests.RequestException as exc:
        logger.error("OpenRouter request failed: %s", exc)
        return None, None

    if not response.ok:
        logger.error("OpenRouter API error (status %d): %s", response.status_code, response.text)
        return None, response.text

    completion = response.json()
    choice = completion.get("choices", [{}])[0] or {}
    message = (choice.get("message") or {}).get("content") or ""
    if not message.strip():
        logger.error("OpenRouter returned empty content: %s", json.dumps(completion)[:1200])
        return None, None

    try:
        return json.loads(strip_code_fences(message)), None
    except json.JSONDecodeError:
        logger.error("Unable to parse OpenRouter response as JSON: %s", message)
        return None, None


def normalize_summary_model(value: Any) -> str:
    model = str(value or "").strip()
    if model in ALLOWED_SUMMARY_MODELS:
        return model
    return OPENROUTER_SUMMARY_MODEL


def heuristic_group_videos(videos: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    groups: Dict[str, List[Dict[str, Any]]] = {}
    ordered_labels: List[str] = []
    for video in videos:
        label = find_rule_category(video.get("title", ""), VIDEO_TOPIC_RULES, "Other picks")
        if label not in groups:
            groups[label] = []
            ordered_labels.append(label)
        groups[label].append(video)
    return [{"category": label, "videos": groups[label]} for label in ordered_labels if groups[label]]


def parse_captured_at(value: str) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def build_keyword_terms(items: List[Dict[str, Any]], limit: int = 4) -> List[str]:
    counts: Dict[str, int] = {}
    for item in items:
        for token in tokenize_topic_text(item.get("summary_text") or item.get("title", "")):
            if token in STOP_WORDS:
                continue
            counts[token] = counts.get(token, 0) + 1
    return [term for term, _ in sorted(counts.items(), key=lambda pair: (-pair[1], pair[0]))[:limit]]


def build_phrase_terms(items: List[Dict[str, Any]], limit: int = 3) -> List[str]:
    doc_counts: Dict[tuple[str, ...], int] = {}
    for item in items:
        tokens = PHRASE_TOKEN_RE.findall(
            " ".join(
                part for part in [str(item.get("title") or ""), str(item.get("full_text") or "")]
                if part
            ).lower()
        )
        seen: set[tuple[str, ...]] = set()
        for size in (3, 2):
            for index in range(len(tokens) - size + 1):
                phrase = tuple(tokens[index:index + size])
                if phrase[0] in PHRASE_STOP_WORDS or phrase[-1] in PHRASE_STOP_WORDS:
                    continue
                if sum(token not in PHRASE_STOP_WORDS for token in phrase) < size - 1:
                    continue
                seen.add(phrase)
        for phrase in seen:
            doc_counts[phrase] = doc_counts.get(phrase, 0) + 1

    ranked = sorted(
        doc_counts.items(),
        key=lambda pair: (-pair[1], -len(pair[0]), " ".join(pair[0])),
    )
    return [" ".join(tokens) for tokens, count in ranked if count >= 2][:limit]


def format_topic_phrase(phrase: str) -> str:
    parts = []
    for token in phrase.split():
        if token in ROMAN_NUMERALS:
            parts.append(token.upper())
        elif token.isdigit():
            parts.append(token)
        elif any(ch.isdigit() for ch in token):
            parts.append(token.capitalize())
        else:
            parts.append(token.capitalize())
    return " ".join(parts)


def select_summary_items(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    filtered = [item for item in items if not should_exclude_from_summary(item)]
    ranked = sorted(
        filtered,
        key=lambda item: (
            -(float(item.get("priority_score") or 0.0)),
            item.get("captured_at") or "",
            item.get("title") or "",
        ),
    )
    if len(ranked) >= 8:
        return ranked
    return sorted(
        items,
        key=lambda item: (
            -(float(item.get("priority_score") or 0.0)),
            item.get("captured_at") or "",
            item.get("title") or "",
        ),
    )


def build_item_term_sets(items: List[Dict[str, Any]]) -> tuple[List[set[str]], Dict[str, int]]:
    doc_freq: Dict[str, int] = {}
    term_sets: List[set[str]] = []
    for item in items:
        tokens = set(tokenize_topic_text(item.get("summary_text") or item.get("title", "")))
        term_sets.append(tokens)
        for token in tokens:
            doc_freq[token] = doc_freq.get(token, 0) + 1
    return term_sets, doc_freq


def shared_term_score(left: set[str], right: set[str], doc_freq: Dict[str, int]) -> float:
    shared = left & right
    if not shared:
        return 0.0
    if len(shared) >= 2:
        return 1.5
    token = next(iter(shared))
    if token in {"coverage", "official", "broadcast", "story", "mission", "live", "models", "science"}:
        return 0.0
    if token in SUMMARY_PRIORITY_TERMS:
        return 1.0
    if any(ch.isdigit() for ch in token):
        return 1.0
    if doc_freq.get(token, 0) <= 2 and len(token) >= 8:
        return 0.95
    return 0.0


def cluster_items_by_topic(items: List[Dict[str, Any]]) -> List[List[Dict[str, Any]]]:
    if not items:
        return []

    term_sets, doc_freq = build_item_term_sets(items)
    parents = list(range(len(items)))

    def find(index: int) -> int:
        while parents[index] != index:
            parents[index] = parents[parents[index]]
            index = parents[index]
        return index

    def union(left: int, right: int) -> None:
        left_root = find(left)
        right_root = find(right)
        if left_root != right_root:
            parents[right_root] = left_root

    for left in range(len(items)):
        for right in range(left + 1, len(items)):
            if shared_term_score(term_sets[left], term_sets[right], doc_freq) >= 0.95:
                union(left, right)

    buckets: Dict[int, List[Dict[str, Any]]] = {}
    for index, item in enumerate(items):
        root = find(index)
        buckets.setdefault(root, []).append(item)

    return list(buckets.values())


def label_topic_bucket(bucket_items: List[Dict[str, Any]]) -> str:
    if not bucket_items:
        return "Notable Feed Chatter"

    phrases = build_phrase_terms(bucket_items, limit=2)
    if phrases:
        lead = format_topic_phrase(phrases[0])
        if len(phrases) > 1 and phrases[1] != phrases[0]:
            return clean_text(f"{lead} and {format_topic_phrase(phrases[1])}", 100)
        return clean_text(lead, 100)

    terms = build_keyword_terms(bucket_items, limit=3)
    if not terms:
        return clean_text(bucket_items[0].get("title"), 100) or "Notable Feed Chatter"

    lead_terms = [term.replace("-", " ").title() for term in terms[:2]]
    if len(lead_terms) == 1:
        return clean_text(f"{lead_terms[0]} Developments", 100)
    return clean_text(f"{lead_terms[0]} and {lead_terms[1]}", 100)



def infer_topic_type(bucket_items: List[Dict[str, Any]]) -> str:
    combined = " ".join(item.get("title", "").lower() for item in bucket_items)
    platforms = {str(item.get("platform") or "").lower() for item in bucket_items if item.get("platform")}

    if any(word in combined for word in ("vs", "debate", "critic", "fight", "argues", "argument", "reacts")):
        return "debate"
    if any(word in combined for word in ("launch", "launched", "release", "released", "unveils", "adds", "announces", "new")):
        return "breakthrough"
    if any(word in combined for word in ("tutorial", "walkthrough", "deep dive", "explainer", "setup", "breakdown", "guide", "course")):
        return "deep_dive"
    if len(bucket_items) >= 3 or len(platforms) >= 2:
        return "trend"
    return "niche"


def infer_depth(bucket_items: List[Dict[str, Any]]) -> str:
    combined = " ".join(item.get("title", "").lower() for item in bucket_items)
    if any(word in combined for word in ("tutorial", "walkthrough", "deep dive", "breakdown", "course", "setup", "explainer")):
        return "high"
    if any(word in combined for word in ("interview", "analysis", "discussion", "strategy")):
        return "medium"
    return "light"


def infer_freshness(bucket_items: List[Dict[str, Any]]) -> str:
    timestamps = [parse_captured_at(str(item.get("captured_at") or "")) for item in bucket_items]
    timestamps = [stamp for stamp in timestamps if stamp is not None]
    if not timestamps:
        return "recent"

    newest = max(timestamps)
    age_hours = (datetime.now(timezone.utc) - newest.astimezone(timezone.utc)).total_seconds() / 3600
    if age_hours <= 6:
        return "today"
    if age_hours <= 30:
        return "fresh"
    if age_hours <= 72:
        return "recent"
    return "older"


def build_topic_score(bucket_items: List[Dict[str, Any]]) -> float:
    count_score = min(len(bucket_items) / 5, 1.0)
    platform_score = min(len({item.get("platform") for item in bucket_items if item.get("platform")}) / 3, 1.0)
    depth_bonus = 0.2 if infer_depth(bucket_items) == "high" else 0.1 if infer_depth(bucket_items) == "medium" else 0.0
    freshness_bonus = {"today": 0.2, "fresh": 0.15, "recent": 0.1, "older": 0.0}[infer_freshness(bucket_items)]
    priority_scores = [float(item.get("priority_score") or 0.0) for item in bucket_items]
    lead_priority = max(priority_scores, default=0.0)
    avg_priority = sum(priority_scores) / len(priority_scores) if priority_scores else 0.0
    priority_bonus = min(0.3, max(0.0, lead_priority) * 0.08 + max(0.0, avg_priority) * 0.04)
    priority_penalty = 0.18 if lead_priority < 0.75 else 0.0
    return round(
        min(1.0, 0.35 + 0.35 * count_score + 0.2 * platform_score + depth_bonus + freshness_bonus + priority_bonus)
        - priority_penalty,
        2,
    )


def build_topic_takeaways(label: str, bucket_items: List[Dict[str, Any]]) -> List[str]:
    terms = build_keyword_terms(bucket_items, limit=3)
    platforms = sorted({(item.get("platform") or "unknown").title() for item in bucket_items})
    authors = [item.get("author") for item in bucket_items if item.get("author")]
    dominant_author = authors[0] if authors else "multiple sources"
    takeaways = [
        f"Core terms repeating in this cluster: {', '.join(terms) if terms else label.lower()}.",
        f"Signal is coming from {', '.join(platforms)} with {len(bucket_items)} saved items.",
        f"Best entry point is likely the strongest source from {dominant_author}."
    ]
    return [clean_text(item, 180) for item in takeaways[:3]]


def build_topic_tension(bucket_items: List[Dict[str, Any]], topic_type: str) -> str:
    combined = " ".join(item.get("title", "").lower() for item in bucket_items)
    if topic_type == "debate":
        return "This cluster has visible disagreement, so it is worth opening both the strongest explainer and the strongest opposing take."
    if any(word in combined for word in ("warning", "problem", "wrong", "failed", "not ready", "leak")):
        return "The interesting tension here is capability versus reliability: people are excited, but there are clear warning signals in the framing."
    return "Most of the coverage is additive rather than adversarial, so the value is context-building more than conflict-watching."


def build_why_showing_up(bucket_items: List[Dict[str, Any]], terms: List[str]) -> str:
    platforms = sorted({(item.get("platform") or "unknown").title() for item in bucket_items})
    phrases = build_phrase_terms(bucket_items, limit=1)
    term_text = format_topic_phrase(phrases[0]) if phrases else (", ".join(terms[:3]) if terms else "repeated themes")
    return clean_text(
        f"This keeps resurfacing across {', '.join(platforms)} around {term_text}, so it reads like a real storyline instead of a stray recommendation.",
        220,
    )


def build_why_it_matters(label: str, bucket_items: List[Dict[str, Any]], terms: List[str]) -> str:
    phrases = build_phrase_terms(bucket_items, limit=1)
    term_text = format_topic_phrase(phrases[0]) if phrases else (", ".join(terms[:2]) if terms else "this theme")
    return clean_text(
        f"This looks worth a deliberate click because your feed is spending repeated attention on {term_text}, not just tossing you a one-off curiosity.",
        220,
    )


def build_topic_hook(label: str, bucket_items: List[Dict[str, Any]], terms: List[str]) -> str:
    combined = " ".join(item.get("title", "") for item in bucket_items).lower()
    phrase = format_topic_phrase(build_phrase_terms(bucket_items, limit=1)[0]) if build_phrase_terms(bucket_items, limit=1) else label
    if "artemis" in combined:
        return clean_text(f"{phrase} has moved from launch hype to live mission updates.", 240)
    if any(word in combined for word in ("gemma", "claude", "openai", "cursor", "openclaw", "tbpn")):
        return clean_text(f"{phrase} keeps popping up as a real product move, not just another AI take.", 240)
    if any(word in combined for word in ("acquire", "acquired", "acquisition", "buys")):
        return clean_text(f"{phrase} looks like an actual deal story worth checking, not background chatter.", 240)
    if any(word in combined for word in ("launch", "released", "release", "announced", "unveiled", "preview", "beta")):
        return clean_text(f"{phrase} looks like a fresh release story that may be worth opening now.", 240)
    if len(bucket_items) == 1:
        return clean_text(bucket_items[0].get("title", ""), 240)
    return clean_text(f"{phrase} keeps resurfacing, which usually means there is a concrete update behind it.", 240)


def build_topic_one_liner(label: str, bucket_items: List[Dict[str, Any]], terms: List[str]) -> str:
    """Single headline for compact UI. Never imply unrelated saves are one story."""
    if not bucket_items:
        return clean_text(label, 240)
    lead_item = max(bucket_items, key=lambda item: float(item.get("priority_score") or 0.0))
    first_title = clean_text(lead_item.get("title", ""), 200)
    if len(bucket_items) == 1 and first_title:
        return first_title
    return build_topic_hook(label, bucket_items, terms)


def build_topic_summary(label: str, bucket_items: List[Dict[str, Any]], topic_type: str, terms: List[str]) -> str:
    platforms = sorted({(item.get("platform") or "unknown").title() for item in bucket_items})
    lead_item = max(bucket_items, key=lambda item: float(item.get("priority_score") or 0.0))
    lead_title = clean_text(lead_item.get("title", ""), 220)
    return clean_text(
        f"The strongest entry here is '{lead_title}'. "
        f"Taken together, the saves across {', '.join(platforms)} suggest this is a real development around {', '.join(terms[:3]) if terms else label.lower()}, not just broad commentary.",
        500,
    )


def build_citations(bucket_items: List[Dict[str, Any]]) -> List[Dict[str, str]]:
    citations = []
    for item in bucket_items[:3]:
        attribution = item.get("author") or f"Unknown ({(item.get('platform') or 'feed').title()})"
        citations.append({
            "quote": clean_text(item.get("title"), 220),
            "attribution": clean_text(attribution, 100),
        })
    return citations


def build_recommended_links(bucket_items: List[Dict[str, Any]]) -> List[Dict[str, str]]:
    picks = []
    seen_urls = set()
    ranked_items = sorted(
        bucket_items,
        key=lambda item: (
            -(float(item.get("priority_score") or 0.0)),
            item.get("captured_at") or "",
            item.get("title") or "",
        ),
    )
    for item in ranked_items:
        url = str(item.get("url") or "").strip()
        if not url or url in seen_urls:
            continue
        seen_urls.add(url)
        picks.append({
            "title": clean_text(item.get("title"), 180),
            "url": url,
            "attribution": clean_text(item.get("author") or (item.get("platform") or "feed").title(), 100),
            "platform": clean_text((item.get("platform") or "unknown").title(), 30),
        })
        if len(picks) >= 3:
            break
    return picks


def build_topic_briefs(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    candidate_items = select_summary_items(items)
    ranked_buckets = sorted(
        cluster_items_by_topic(candidate_items),
        key=lambda bucket: (-build_topic_score(bucket), -len(bucket)),
    )

    strong_buckets = [
        bucket for bucket in ranked_buckets
        if max((float(item.get("priority_score") or 0.0) for item in bucket), default=0.0) >= 0.75
    ]
    source_buckets = strong_buckets[:4] if len(strong_buckets) >= 2 else ranked_buckets[:4]

    topic_briefs = []
    for full_bucket in source_buckets:
        bucket_items = full_bucket[:6]
        label = label_topic_bucket(bucket_items)
        terms = build_keyword_terms(bucket_items)
        topic_type = infer_topic_type(bucket_items)
        score = build_topic_score(bucket_items)
        platforms = sorted({(item.get("platform") or "unknown").title() for item in bucket_items})
        brief = {
            "title": clean_text(label, 100),
            "one_liner": build_topic_one_liner(label, bucket_items, terms),
            "type": topic_type,
            "score": score,
            "why_showing_up": build_why_showing_up(bucket_items, terms),
            "summary": build_topic_summary(label, bucket_items, topic_type, terms),
            "takeaways": build_topic_takeaways(label, bucket_items),
            "tension": build_topic_tension(bucket_items, topic_type),
            "why_it_matters": build_why_it_matters(label, bucket_items, terms),
            "signals": {
                "item_count": len(bucket_items),
                "bucket_total": len(full_bucket),
                "platform_count": len(platforms),
                "platforms": platforms,
                "freshness": infer_freshness(bucket_items),
                "depth": infer_depth(bucket_items),
            },
            "badges": [
                badge for badge in [
                    "Cross-platform" if len(platforms) >= 2 else None,
                    "New" if infer_freshness(bucket_items) in {"today", "fresh"} else None,
                    "Deep dive" if infer_depth(bucket_items) == "high" else None,
                    "Debate" if topic_type == "debate" else None,
                    "High relevance" if score >= 0.75 else None,
                ] if badge
            ],
            "citations": build_citations(bucket_items),
            "recommended_links": build_recommended_links(bucket_items),
        }
        topic_briefs.append(brief)

    return topic_briefs


def build_summary_overview(items: List[Dict[str, Any]], topics: List[Dict[str, Any]]) -> Dict[str, Any]:
    platforms = sorted({(item.get("platform") or "unknown").title() for item in items})
    lead = topics[0] if topics else None
    lead_line = lead.get("one_liner") if lead else ""
    return {
        "headline": clean_text(
            lead_line or (f"{lead['title']} is leading your feed right now." if lead else "Your feed is ready to summarize."),
            120,
        ),
        "deck": clean_text(
            f"{len(topics)} stories made the cut across {', '.join(platforms)}. "
            "This brief is tuned for what actually changed, not general chatter.",
            240,
        ),
        "stats": [
            {"label": "Saved items", "value": str(len(items))},
            {"label": "Platforms", "value": str(len(platforms))},
            {"label": "Top topics", "value": str(len(topics))},
        ],
    }


def build_worth_your_time_picks(topics: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    picks = []
    seen_urls = set()
    for topic in sorted(topics, key=lambda topic: float(topic.get("score") or 0), reverse=True):
        for link in topic.get("recommended_links", []):
            url = str(link.get("url") or "").strip()
            if not url or url in seen_urls:
                continue
            seen_urls.add(url)
            picks.append({
                "title": clean_text(link.get("title"), 180),
                "url": url,
                "attribution": clean_text(link.get("attribution"), 100),
                "platform": clean_text(link.get("platform"), 30),
                "reason": clean_text(
                    f"Best quick click into {topic.get('title', 'a top topic')}.",
                    180,
                ),
            })
            if len(picks) >= 6:
                return picks
    return picks


def attach_signals_to_model_topics(
    model_topics: List[Dict[str, Any]],
    items: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Attach heuristic signals to LLM-clustered topics using item_urls for lookup."""
    items_by_url = {str(item.get("url") or "").strip(): item for item in items if item.get("url")}

    result = []
    for topic in model_topics:
        if not isinstance(topic, dict):
            continue

        item_urls = [str(u).strip() for u in (topic.get("item_urls") or []) if u]
        bucket_items = [items_by_url[u] for u in item_urls if u in items_by_url]
        if not bucket_items:
            bucket_items = items[:3]

        platforms = sorted({(item.get("platform") or "unknown").title() for item in bucket_items})
        topic_type = infer_topic_type(bucket_items)
        score = build_topic_score(bucket_items)
        terms = build_keyword_terms(bucket_items)

        citations = [
            {
                "quote": clean_text(c.get("quote", ""), 300),
                "attribution": clean_text(c.get("attribution", ""), 100),
            }
            for c in (topic.get("citations") or [])[:3]
            if isinstance(c, dict) and c.get("quote") and c.get("attribution")
        ]

        # Drop single-item topics — they're almost always noise (one stray tweet, wildlife photo, etc.)
        # unless the priority score is very high (a major breaking announcement from a single source)
        if len(bucket_items) < 2:
            lead_priority = max((float(item.get("priority_score") or 0.0) for item in bucket_items), default=0.0)
            if lead_priority < 3.0:
                continue

        result.append({
            "title": clean_text(topic.get("title", ""), 100),
            "one_liner": clean_text(topic.get("one_liner", ""), 240),
            "type": topic_type,
            "score": score,
            "badges": [badge for badge in [
                "Cross-platform" if len(platforms) >= 2 else None,
                "New" if infer_freshness(bucket_items) in {"today", "fresh"} else None,
                "Debate" if topic_type == "debate" else None,
            ] if badge],
            "citations": citations,
            "recommended_links": build_recommended_links(bucket_items),
            "signals": {
                "item_count": len(bucket_items),
                "bucket_total": len(bucket_items),
                "platform_count": len(platforms),
                "platforms": platforms,
                "freshness": infer_freshness(bucket_items),
            },
        })

    return result


def summarize_with_openrouter(items: List[Dict[str, Any]], model: str, seen_topics: List[str] | None = None) -> Dict[str, Any]:
    # For the LLM path, always apply strict exclusion — never fall back to unfiltered items.
    # select_summary_items has a fallback that includes excluded items when <8 qualify,
    # which is correct for the heuristic path but wrong for the LLM.
    filtered = [item for item in items if not should_exclude_from_summary(item)]
    summary_items = sorted(
        filtered,
        key=lambda item: (-(float(item.get("priority_score") or 0.0)), item.get("captured_at") or "", item.get("title") or ""),
    ) or select_summary_items(items)  # last-resort: no items survived filtering

    if not OPENROUTER_API_KEY:
        logger.warning("OPENROUTER_API_KEY is not set. Falling back to heuristic summary briefs.")
        heuristic_topics = build_topic_briefs(items)
        overview = build_summary_overview(items, heuristic_topics)
        return {"overview": overview, "topics": heuristic_topics, "nothing_new": not heuristic_topics}

    seen_note = ""
    if seen_topics:
        seen_list = "; ".join(seen_topics[:10])
        seen_note = f"\n\nAlready shown to user recently (suppress unless there is a clear new development): {seen_list}"

    messages = [
        {"role": "system", "content": OPENROUTER_SUMMARY_SYSTEM_PROMPT},
        {
            "role": "user",
            "content": f"{OPENROUTER_SUMMARY_USER_INSTRUCTIONS}\n\nFeed items:\n{format_feed_items(summary_items[:60])}{seen_note}",
        },
    ]
    parsed, _ = openrouter_chat_completion(
        messages,
        model=model,
        temperature=0.2,
        response_schema=OPENROUTER_SUMMARY_PAGE_SCHEMA,
        max_tokens=700,
    )

    if parsed is None:
        fallback_messages = [
            {"role": "system", "content": OPENROUTER_SUMMARY_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": (
                    f"{OPENROUTER_SUMMARY_USER_INSTRUCTIONS}\n\n"
                    "Return a JSON object with `overview` and `topics`.\n\n"
                    f"Feed items:\n{format_feed_items(summary_items[:40])}"
                ),
            },
        ]
        parsed, _ = openrouter_chat_completion(
            fallback_messages,
            model=model,
            temperature=0.2,
            response_schema=None,
            max_tokens=600,
        )

    if not isinstance(parsed, dict):
        heuristic_topics = build_topic_briefs(items)
        overview = build_summary_overview(items, heuristic_topics)
        return {"overview": overview, "topics": heuristic_topics, "nothing_new": not heuristic_topics}

    model_topics = parsed.get("topics") if isinstance(parsed.get("topics"), list) else []
    if not model_topics:
        return {"overview": None, "topics": [], "nothing_new": True}

    topics = attach_signals_to_model_topics(model_topics, summary_items)

    parsed_overview = parsed.get("overview") if isinstance(parsed.get("overview"), dict) else {}
    heuristic_overview = build_summary_overview(items, topics)
    overview = {
        "headline": clean_text(parsed_overview.get("headline") or heuristic_overview["headline"], 120),
        "deck": heuristic_overview["deck"],
        "stats": heuristic_overview["stats"],
    }

    return {"overview": overview, "topics": topics, "nothing_new": False}


def build_summary_response(items: List[Dict[str, Any]], model: str, seen_topics: List[str] | None = None) -> Dict[str, Any]:
    summary = summarize_with_openrouter(items, model, seen_topics=seen_topics)
    nothing_new = summary.get("nothing_new", False)
    topics = summary.get("topics", [])
    overview = summary.get("overview") or build_summary_overview(items, topics)
    picks = build_worth_your_time_picks(topics)
    return {
        "overview": overview,
        "topics": topics,
        "picks": picks,
        "model": model,
        "nothing_new": nothing_new,
    }


def rerank_with_groq(videos: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    if not GROQ_API_KEY:
        logger.warning("GROQ_API_KEY is not set. Falling back to heuristic grouping.")
        return heuristic_group_videos(videos)

    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {
            "role": "user",
            "content": f"{USER_INSTRUCTIONS}\n\nVideos:\n{format_video_list(videos)}",
        },
    ]
    parsed, _ = groq_chat_completion(
        messages,
        temperature=0.2,
        response_schema=GROUP_RESPONSE_SCHEMA,
        max_tokens=1000,
    )

    if parsed is None:
        fallback_messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": (
                    f"{USER_INSTRUCTIONS}\n\n"
                    "If strict schema validation fails, still return a JSON object with a `groups` array.\n\n"
                    f"Videos:\n{format_video_list(videos[:20])}"
                ),
            },
        ]
        parsed, _ = groq_chat_completion(
            fallback_messages,
            temperature=0.2,
            response_schema=None,
            max_tokens=800,
        )

    candidate_groups = parsed.get("groups") if isinstance(parsed, dict) else None
    curated = sanitize_grouped_response(candidate_groups, videos) if candidate_groups is not None else []
    if curated and not is_default_grouping(curated, videos):
        return curated

    return heuristic_group_videos(videos)


@app.route("/rerank", methods=["POST"])
def rerank_endpoint():
    payload = request.get_json(silent=True) or {}
    videos = payload.get("videos")
    if not isinstance(videos, list):
        return jsonify({"error": "Payload must include a 'videos' array."}), 400

    normalized = normalize_videos(videos)
    if not normalized:
        return jsonify({"groups": []})

    video_hash = create_video_hash(normalized)
    cached_groups = get_cached_result(rerank_result_cache, video_hash, MIN_REQUEST_INTERVAL_SEC)
    if cached_groups is not None:
        logger.info("Serving cached rerank result for repeated request")
        return jsonify({"groups": cached_groups, "cached": True})

    curated = rerank_with_groq(normalized)
    if curated and not is_default_grouping(curated, normalized):
        set_cached_result(rerank_result_cache, video_hash, curated)

    return jsonify({"groups": curated, "cached": False})


@app.route("/summarize", methods=["POST"])
def summarize_endpoint():
    """Generate a 'Talk of the Town' summary from feed items."""
    payload = request.get_json(silent=True) or {}
    items = payload.get("items")
    summary_model = normalize_summary_model(payload.get("summary_model"))
    
    if not isinstance(items, list):
        return jsonify({"error": "Payload must include an 'items' array."}), 400
    
    normalized = normalize_feed_items(items)
    if not normalized:
        return jsonify({"overview": None, "topics": [], "picks": [], "model": summary_model})
    
    item_hash = create_item_hash(normalized)
    cache_key = f"summary_{summary_model}_{item_hash}"
    cached_summary = get_cached_result(summary_result_cache, cache_key, SUMMARY_REQUEST_INTERVAL_SEC)
    if cached_summary is not None:
        logger.info("Serving cached summary result for repeated request")
        return jsonify({**cached_summary, "cached": True})
    
    seen_topics = payload.get("seen_topics")
    if not isinstance(seen_topics, list):
        seen_topics = None
    else:
        seen_topics = [str(t).strip() for t in seen_topics if t and str(t).strip()][:20]

    summary_payload = build_summary_response(normalized, summary_model, seen_topics=seen_topics)
    if summary_payload.get("topics"):
        set_cached_result(summary_result_cache, cache_key, summary_payload)

    return jsonify({**summary_payload, "cached": False})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", SERVER_PORT))
    host = "0.0.0.0" if os.environ.get("PORT") else "127.0.0.1"
    logger.info("Starting custom feed server on http://%s:%s", host, port)
    app.run(host=host, port=port, debug=False)
