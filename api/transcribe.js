// Vercel serverless function: POST audio → OpenAI Whisper → text
// Also uploads the raw audio to Vercel Blob so the dream page can replay it.
//
// Setup (one-time, on Vercel):
//   vercel env add OPENAI_API_KEY production  →  paste OpenAI key
//   (BLOB_READ_WRITE_TOKEN comes from connecting Vercel Blob in the dashboard)
//
// Cost: Whisper $0.006/min · Blob storage tiny per recording.

import { put } from '@vercel/blob';

export const config = {
  api: {
    bodyParser: false, // raw multipart, we forward it directly
  },
  maxDuration: 60,
};

export default async function handler(req, res) {
  // CORS for safety even though same-origin
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST with audio/* body.' });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(503).json({
      error: 'transcription_not_configured',
      message: 'OPENAI_API_KEY is not set on this deployment. Run `vercel env add OPENAI_API_KEY production` and redeploy. Until then, the browser falls back to SpeechRecognition.',
    });
  }

  try {
    // Collect raw body
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const audioBuffer = Buffer.concat(chunks);

    if (audioBuffer.length === 0) {
      return res.status(400).json({ error: 'empty_audio', message: 'No audio data received.' });
    }
    if (audioBuffer.length > 25 * 1024 * 1024) {
      return res.status(413).json({
        error: 'audio_too_large',
        message: 'Whisper accepts files up to 25 MB. Record a shorter dream or compress audio client-side.',
      });
    }

    // Build multipart form for OpenAI
    const contentType = req.headers['content-type'] || 'audio/webm';
    const filename =
      contentType.includes('mp4') ? 'dream.mp4' :
      contentType.includes('ogg') ? 'dream.ogg' :
      contentType.includes('wav') ? 'dream.wav' :
      'dream.webm';

    const form = new FormData();
    form.append('file', new Blob([audioBuffer], { type: contentType }), filename);
    form.append('model', 'whisper-1');
    form.append('response_format', 'json');
    // Light prompt nudges Whisper toward dream-journal phrasing
    form.append('prompt', "I was in a dream. The following describes a dream I just had.");

    const openaiRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });

    if (!openaiRes.ok) {
      const errText = await openaiRes.text();
      console.error('Whisper API error', openaiRes.status, errText);
      return res.status(502).json({
        error: 'whisper_api_error',
        status: openaiRes.status,
        message: errText.slice(0, 500),
      });
    }

    const data = await openaiRes.json();

    // Also save the audio to Vercel Blob so the dream page can replay it.
    // Best-effort: if Blob isn't configured or upload fails, we still return
    // the transcript — the user just loses replay capability for this one.
    let audio_url = null;
    const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
    if (blobToken) {
      try {
        const ext = filename.split('.').pop();
        const rnd = Math.random().toString(36).slice(2, 8);
        const blob = await put(
          `audio/${Date.now()}-${rnd}.${ext}`,
          audioBuffer,
          { access: 'public', contentType, token: blobToken }
        );
        audio_url = blob.url;
      } catch (blobErr) {
        console.warn('Audio blob upload failed (transcript still returned):', blobErr.message);
      }
    }

    return res.status(200).json({
      text: data.text || '',
      audio_url,
      duration_seconds: null,
      audio_bytes: audioBuffer.length,
    });
  } catch (err) {
    console.error('transcribe handler error', err);
    return res.status(500).json({
      error: 'server_error',
      message: err.message || 'Unexpected error during transcription.',
    });
  }
}
