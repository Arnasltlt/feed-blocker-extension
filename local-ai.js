/**
 * LocalAIService
 * Encapsulates interaction with Chrome's built-in AI (Prompt API).
 * Replaces the external Python/Groq server when available.
 */
class LocalAIService {
  constructor() {
    this.session = null;
  }

  /**
   * Check if the Chrome Prompt API is available.
   * @returns {Promise<boolean>}
   */
  async isAvailable() {
    if (!window.ai || !window.ai.languageModel) {
      return false;
    }
    try {
      const availability = await window.ai.languageModel.availability();
      return availability === 'readily';
    } catch (error) {
      console.warn('[LocalAI] Availability check failed:', error);
      return false;
    }
  }

  /**
   * Format the video list into a string for the prompt.
   * Matches format_video_list from server.py
   */
  formatVideoList(videos) {
    return videos
      .map((video, index) => {
        const channel = video.channel || 'Unknown channel';
        const position = (video.position || 0) + 1; // 1-based index
        // Use original position if available, or index
        const displayPos = index + 1; 
        return `${displayPos}. Title: ${video.title} | Channel: ${channel} | URL: ${video.url}`;
      })
      .join('\n');
  }

  /**
   * Rerank videos using the local model.
   * @param {Array} videos - List of video objects
   * @returns {Promise<Array|null>} - Grouped videos or null if failed
   */
  async rerank(videos) {
    if (!videos || videos.length === 0) {
      return [];
    }

    try {
      const systemPrompt = 
        "You are a JSON-only assistant that groups YouTube recommendations by learning-focused themes. " +
        'You must respond with valid JSON that matches exactly this schema: {"groups":[{"category":string,"videos":[{"title":string,"url":string}]}]}. ' +
        "After any internal reasoning, your assistant message content must contain only that JSON object—never leave the content empty. " +
        "Never include markdown, explanations, code fences, or extra fields. " +
        "Only reference the videos provided to you—never invent new URLs or titles. " +
        "Favor tutorials, explainers, long-form breakdowns, courses, research recaps, and other learning-focused content.";

      const userInstructions = 
        "Group every provided video into learning-focused categories using these rules:\n" +
        "1. Choose clear category labels (e.g., 'Programming Deep Dives', 'Mindset & Strategy', 'Quick Inspiration').\n" +
        "2. Prefer grouping tutorials, walkthroughs, explainers, courses, and research recaps together.\n" +
        "3. Deprioritize shorts, drama, gossip, or clickbait by placing them in lower-value categories near the end.\n" +
        "4. Include every video exactly once in some group. If a video does not fit any high-value group, place it in a catch-all 'Other' style section.\n" +
        "Limit yourself to at most six categories, each containing at most ten videos. " +
        "Return the grouped structure strictly as JSON following the required schema.";

      const videoList = this.formatVideoList(videos);
      const prompt = `${userInstructions}\n\nVideos:\n${videoList}`;
      
      // Schema derived from server.py GROUP_RESPONSE_SCHEMA["schema"]
      const responseSchema = {
        "type": "object",
        "properties": {
            "groups": {
                "type": "array",
                "minItems": 1,
                "maxItems": 6,
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                        "category": {"type": "string"},
                        "videos": {
                            "type": "array",
                            "minItems": 1,
                            "maxItems": 10,
                            "items": {
                                "type": "object",
                                "additionalProperties": false,
                                "properties": {
                                    "title": {"type": "string"},
                                    "url": {"type": "string"} 
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
        "additionalProperties": false
      };

      console.log('[LocalAI] Creating session...');
      
      // Always create a new session to avoid context pollution for now, or reuse if needed.
      // For now, simple request-response is safer.
      if (this.session) {
        this.session.destroy();
        this.session = null;
      }

      this.session = await window.ai.languageModel.create({
        systemPrompt: systemPrompt
      });

      console.log('[LocalAI] Prompting model...');
      // Use responseConstraint if supported (Chrome 138+ feature, might vary by flag/version)
      // We pass it in options.
      let result;
      try {
          result = await this.session.prompt(prompt, {
            responseConstraint: {
                type: "json",
                schema: responseSchema
            }
          });
      } catch (e) {
          // Fallback if strict constraint fails or API signature differs slightly in current Canary
          console.warn('[LocalAI] Prompt with constraint failed, retrying without explicit constraint object...', e);
          result = await this.session.prompt(prompt);
      }

      console.log('[LocalAI] Raw result:', result);

      // Clean up potential markdown fences if model adds them despite instructions
      const cleanResult = this.stripCodeFences(result);
      const parsed = JSON.parse(cleanResult);

      if (!parsed || !parsed.groups) {
        throw new Error('Invalid JSON structure returned');
      }

      return parsed.groups;

    } catch (error) {
      console.error('[LocalAI] Rerank failed:', error);
      return null;
    }
  }

  stripCodeFences(text) {
    let trimmed = (text || "").trim();
    if (trimmed.startsWith("```")) {
        // Remove first ``` line
        const parts = trimmed.split('\n');
        if (parts.length > 1) {
             // Remove first line (```json or similar)
             parts.shift();
             // Find end fence
             const endFenceIndex = parts.findIndex(line => line.trim().startsWith("```"));
             if (endFenceIndex !== -1) {
                 trimmed = parts.slice(0, endFenceIndex).join('\n');
             } else {
                 trimmed = parts.join('\n');
             }
        }
    }
    return trimmed.trim();
  }
}

// Expose globally so other scripts can find it
window.LocalAIService = new LocalAIService();

