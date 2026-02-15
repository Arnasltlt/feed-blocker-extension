#!/usr/bin/env python3
"""
Local helper server that groups YouTube recommendations via Groq.

Expose POST /rerank
Body: {"videos": [{"title": "...", "url": "...", "channel": "..."}]}
Response: {"groups": [{"category": "...", "videos": [{"title": "...", "url": "..."}]}]}
"""

from __future__ import annotations

import json
import logging
import os
import time
from typing import Any, Dict, List
from collections import defaultdict

import requests
from flask import Flask, jsonify, request
from flask_cors import CORS

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("custom_feed")

GROQ_API_KEY = os.environ.get("GROQ_API_KEY")
GROQ_MODEL = os.environ.get("GROQ_MODEL", "openai/gpt-oss-20b")
MAX_VIDEOS = max(1, int(os.environ.get("CUSTOM_FEED_MAX_VIDEOS", "30")))
SERVER_PORT = int(os.environ.get("CUSTOM_FEED_SERVER_PORT", "11400"))
GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions"

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

SUMMARY_SYSTEM_PROMPT = (
    "You are a news digest curator analyzing social media feeds from YouTube, LinkedIn, and Twitter/X. "
    "Your job is to identify the hottest topics people are talking about and create a concise 'Talk of the Town' summary. "
    "Each topic must include direct quotes or paraphrased statements with explicit attribution to specific people or sources from the feed. "
    "Never invent quotes or attributions—only cite what appears in the provided feed items. "
    "Never include markdown, explanations, code fences, or extra fields. "
)

SUMMARY_USER_INSTRUCTIONS = (
    "Analyze the provided feed items and identify the 3-5 hottest topics across all platforms. "
    "For each topic:\n"
    "1. Create a clear, engaging title that captures the essence of the discussion\n"
    "2. Write a paragraph (2-4 sentences) summarizing what people are saying, key perspectives, and why it's trending\n"
    "3. Include 1-5 citations: direct quotes or close paraphrases with explicit attribution (person name, channel, or source from the feed). "
    "   Example: {\"quote\": \"AI will change everything in the next 5 years\", \"attribution\": \"John Smith (Tech Daily)\"}\n"
    "4. Only cite content that appears in the feed items—never invent quotes or sources\n"
    "5. Focus on topics that appear multiple times or from multiple sources\n"
    "6. Prioritize substantive discussions over clickbait or trivial content\n"
    "Return exactly 3-5 topics in order of relevance/popularity."
)

MAX_SUMMARY_ITEMS = 100

app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}})

# Rate limiting: track last request time per video hash
request_cache: Dict[str, float] = {}
MIN_REQUEST_INTERVAL_SEC = 10  # Minimum 10 seconds between requests for same videos


def create_video_hash(videos: List[Dict[str, Any]]) -> str:
    """Create a hash from video URLs for caching/rate limiting."""
    if not videos:
        return ""
    urls = sorted([str(v.get("url", "")).strip() for v in videos if v.get("url")])
    return "|".join(urls)


def normalize_videos(videos: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    normalized: List[Dict[str, Any]] = []
    for entry in videos:
        if not isinstance(entry, dict):
            continue
        title = str(entry.get("title") or entry.get("text") or "").strip()
        url = str(entry.get("url") or entry.get("href") or "").strip()
        channel = str(entry.get("channel") or "").strip()
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


def normalize_feed_items(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Normalize and deduplicate feed items from multiple platforms."""
    normalized: List[Dict[str, Any]] = []
    seen_titles = set()
    
    for entry in items:
        if not isinstance(entry, dict):
            continue
        title = str(entry.get("title") or entry.get("text") or "").strip()
        platform = str(entry.get("platform") or "").strip()
        author = str(entry.get("channel") or entry.get("author") or "").strip()
        
        if not title or title in seen_titles:
            continue
            
        seen_titles.add(title)
        normalized.append({
            "title": title,
            "platform": platform,
            "author": author
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
        lines.append(f"{idx}. [{platform.upper()}] {item['title']} (by {author})")
    return "\n".join(lines)


def create_item_hash(items: List[Dict[str, Any]]) -> str:
    """Create a hash from feed items for caching/rate limiting."""
    if not items:
        return ""
    titles = sorted([str(item.get("title", "")).strip() for item in items if item.get("title")])
    return "|".join(titles[:50])  # Use first 50 titles for hash


def summarize_with_groq(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Call Groq API to generate topic summaries."""
    if not GROQ_API_KEY:
        logger.warning("GROQ_API_KEY is not set. Returning empty topics.")
        return []

    payload = {
        "model": GROQ_MODEL,
        "messages": [
            {"role": "system", "content": SUMMARY_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": f"{SUMMARY_USER_INSTRUCTIONS}\n\nFeed items:\n{format_feed_items(items)}",
            },
        ],
        "temperature": 0.3,
        "response_format": {
            "type": "json_schema",
            "json_schema": SUMMARY_RESPONSE_SCHEMA,
        },
    }

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
        if not response.ok:
            error_body = response.text
            logger.error("Groq API error (status %d): %s", response.status_code, error_body)
            return []
        
        completion = response.json()
        choice = completion.get("choices", [{}])[0] or {}
        message = (choice.get("message") or {}).get("content") or ""
        
        if not message.strip():
            logger.error("Groq returned empty content: %s", json.dumps(completion)[:800])
            return []
        
        try:
            parsed = json.loads(strip_code_fences(message))
        except json.JSONDecodeError as exc:
            logger.error("Unable to parse Groq response as JSON: %s", message)
            return []
        
        topics = parsed.get("topics", [])
        if not isinstance(topics, list):
            return []
        
        # Validate and clean topics
        validated_topics = []
        for topic in topics:
            if isinstance(topic, dict) and "title" in topic and "summary" in topic:
                validated = {
                    "title": str(topic["title"])[:100],
                    "summary": str(topic["summary"])[:500]
                }
                if isinstance(topic.get("citations"), list):
                    validated["citations"] = [
                        {"quote": str(c.get("quote", ""))[:300], "attribution": str(c.get("attribution", ""))[:100]}
                        for c in topic["citations"][:5]
                        if isinstance(c, dict) and c.get("quote") and c.get("attribution")
                    ]
                validated_topics.append(validated)
        
        return validated_topics
        
    except (requests.RequestException, KeyError, json.JSONDecodeError) as exc:
        logger.error("Groq request failed: %s", exc)
        if hasattr(exc, "response") and exc.response is not None:
            logger.error("Response body: %s", exc.response.text)
        return []


def rerank_with_groq(videos: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    if not GROQ_API_KEY:
        logger.warning("GROQ_API_KEY is not set. Returning the original grouping.")
        return [{"category": "All videos", "videos": videos}]

    payload = {
        "model": GROQ_MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": f"{USER_INSTRUCTIONS}\n\nVideos:\n{format_video_list(videos)}",
            },
        ],
        "temperature": 0.2,
        "response_format": {
            "type": "json_schema",
            "json_schema": GROUP_RESPONSE_SCHEMA,
        },
    }

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
        if not response.ok:
            error_body = response.text
            logger.error("Groq API error (status %d): %s", response.status_code, error_body)
            return [{"category": "All videos", "videos": videos}]
        completion = response.json()
        choice = completion.get("choices", [{}])[0] or {}
        message = (choice.get("message") or {}).get("content") or ""
        if not message.strip():
            logger.error("Groq returned empty content: %s", json.dumps(completion)[:800])
            return [{"category": "All videos", "videos": videos}]
        try:
            parsed = json.loads(strip_code_fences(message))
        except json.JSONDecodeError as exc:
            logger.error("Unable to parse Groq response as JSON: %s", message)
            logger.error("Raw completion: %s", json.dumps(completion)[:800])
            raise
        candidate_groups = parsed.get("groups")
        return sanitize_grouped_response(candidate_groups, videos)
    except (requests.RequestException, KeyError, json.JSONDecodeError) as exc:
        logger.error("Groq request failed: %s", exc)
        if hasattr(exc, "response") and exc.response is not None:
            logger.error("Response body: %s", exc.response.text)
        return [{"category": "All videos", "videos": videos}]


@app.route("/rerank", methods=["POST"])
def rerank_endpoint():
    payload = request.get_json(silent=True) or {}
    videos = payload.get("videos")
    if not isinstance(videos, list):
        return jsonify({"error": "Payload must include a 'videos' array."}), 400

    normalized = normalize_videos(videos)
    if not normalized:
        return jsonify({"groups": []})

    # Rate limiting: check if we've requested this set recently
    video_hash = create_video_hash(normalized)
    now = time.time()
    last_request_time = request_cache.get(video_hash, 0)
    time_since_last = now - last_request_time

    if time_since_last < MIN_REQUEST_INTERVAL_SEC:
        logger.info(
            "Rate limit: skipping request for same videos (last request %.1fs ago)",
            time_since_last,
        )
        return jsonify({"groups": [{"category": "All videos", "videos": normalized}]})

    request_cache[video_hash] = now
    # Clean old entries (keep only last 100)
    if len(request_cache) > 100:
        oldest_key = min(request_cache.items(), key=lambda x: x[1])[0]
        del request_cache[oldest_key]

    curated = rerank_with_groq(normalized)
    return jsonify({"groups": curated})


@app.route("/summarize", methods=["POST"])
def summarize_endpoint():
    """Generate a 'Talk of the Town' summary from feed items."""
    payload = request.get_json(silent=True) or {}
    items = payload.get("items")
    
    if not isinstance(items, list):
        return jsonify({"error": "Payload must include an 'items' array."}), 400
    
    normalized = normalize_feed_items(items)
    if not normalized:
        return jsonify({"topics": []})
    
    # Rate limiting: 30 seconds minimum between identical requests
    item_hash = create_item_hash(normalized)
    now = time.time()
    cache_key = f"summary_{item_hash}"
    last_request_time = request_cache.get(cache_key, 0)
    time_since_last = now - last_request_time
    
    if time_since_last < 30:
        logger.info(
            "Rate limit: skipping summary request (last request %.1fs ago)",
            time_since_last,
        )
        return jsonify({
            "topics": [],
            "message": f"Please wait {int(30 - time_since_last)} more seconds before requesting another summary."
        })
    
    request_cache[cache_key] = now
    # Clean old entries
    if len(request_cache) > 100:
        oldest_key = min(request_cache.items(), key=lambda x: x[1])[0]
        del request_cache[oldest_key]
    
    topics = summarize_with_groq(normalized)
    return jsonify({"topics": topics})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", SERVER_PORT))
    host = "0.0.0.0" if os.environ.get("PORT") else "127.0.0.1"
    logger.info("Starting custom feed server on http://%s:%s", host, port)
    app.run(host=host, port=port, debug=False)

