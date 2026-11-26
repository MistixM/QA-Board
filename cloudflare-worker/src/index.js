const MODEL = '@cf/openai/gpt-oss-20b';
const TASKS = {
  title: {
    system: 'You generate concise bug report titles. Respond with only the title — no quotes, no punctuation at the end, no explanation. Max 10 words.',
    user: 'Generate a title for this QA issue: '
  },
  brief: {
    system: 'You generate brief descriptions for QA bug reports. Respond with only the brief description — 1-2 sentences max, no quotes, no explanation.',
    user: 'Generate a brief description for this QA issue: '
  },
  severity: {
    system: 'You triage QA bug reports by severity. Respond with exactly one word — Low, Medium, or High — no explanation, no punctuation. Use High for broken/blocking functionality, Medium for visible but non-blocking issues, Low for cosmetic/minor issues.',
    user: 'Classify the severity of this QA issue: '
  }
};

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const headers = {
      'Cache-Control': 'no-store',
      Vary: 'Origin'
    };
    if (origin && origin === env.ALLOWED_ORIGIN) {
      headers['Access-Control-Allow-Origin'] = origin;
      headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
      headers['Access-Control-Allow-Headers'] = 'Authorization, Content-Type';
    }
    const json = (body, status) => Response.json(body, { status, headers });

    if (!env.AI_ENDPOINT_TOKEN || !env.ALLOWED_ORIGIN || !env.AI) {
      return json({ error: 'AI Worker setup is incomplete. Configure the AI binding, AI_ENDPOINT_TOKEN, and ALLOWED_ORIGIN.' }, 503);
    }
    if (origin && origin !== env.ALLOWED_ORIGIN) {
      return json({ error: 'Extension origin is not allowed.' }, 403);
    }
    if (new URL(request.url).pathname !== '/generate') {
      return json({ error: 'Endpoint not found.' }, 404);
    }
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'POST') {
      return Response.json({ error: 'Use POST /generate.' }, { status: 405, headers: { ...headers, Allow: 'POST, OPTIONS' } });
    }
    if (request.headers.get('Authorization') !== `Bearer ${env.AI_ENDPOINT_TOKEN}`) {
      return json({ error: 'Invalid AI endpoint token.' }, 401);
    }
    if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      return json({ error: 'Send an application/json request.' }, 415);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Request body must be valid JSON.' }, 400);
    }
    if (!body || typeof body.task !== 'string' || !Object.hasOwn(TASKS, body.task) || typeof body.description !== 'string' || body.description.trim().length <= 10) {
      return json({ error: 'Provide a title, brief, or severity task and a description longer than 10 characters.' }, 400);
    }

    const task = TASKS[body.task];
    let timeout;
    try {
      const result = await Promise.race([
        env.AI.run(MODEL, {
          stream: false,
          messages: [
            { role: 'system', content: task.system },
            { role: 'user', content: task.user + body.description.trim() }
          ]
        }),
        new Promise((resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('MDEV_AI_TIMEOUT')), 55000);
        })
      ]);

      // Workers AI models can use native text or chat-completion response shapes.
      const text = result?.response ?? result?.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || !text.trim()) {
        return json({ error: 'Cloudflare AI returned empty or malformed generated text. Please try again.' }, 502);
      }
      return json({ text: text.trim() }, 200);
    } catch (error) {
      // Classify upstream failures without returning account details or raw errors.
      const message = `${error?.internalCode || error?.code || ''} ${error?.message || ''}`.trim();
      if (message === 'MDEV_AI_TIMEOUT' || /\b300[78]\b|timed?\s*out|timeout/i.test(message)) {
        return json({ error: 'Cloudflare AI generation timed out. Please try again.' }, 504);
      }
      if (/\b3036\b|daily.*(?:allocation|limit)|quota|neurons.*(?:exceeded|exhausted)/i.test(message)) {
        return json({ error: 'Cloudflare Workers AI daily free allocation is exhausted. Try again after the daily reset at 00:00 UTC.' }, 429);
      }
      if (/\b(?:3040|429)\b|capacity|rate.?limit|too many requests/i.test(message)) {
        return json({ error: 'Cloudflare AI is busy or rate-limited. Please try again later.' }, 429);
      }
      if (/\b5035\b|requires.*paid/i.test(message)) {
        return json({ error: 'Cloudflare requires a paid plan for this model on your account.' }, 502);
      }
      return json({ error: 'Cloudflare AI generation failed. Check Workers AI access in your Cloudflare dashboard and try again.' }, 502);
    } finally {
      clearTimeout(timeout);
    }
  }
};
