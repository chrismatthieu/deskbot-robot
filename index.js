require('dotenv').config();
const { Cam } = require('onvif');
const ollama = require('ollama').default;
const OpenAI = require('openai');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const record = require('node-record-lpcm16');

// Camera configuration
const cameraConfig = {
  hostname: process.env.CAMERA_HOSTNAME || '192.168.0.42',
  username: process.env.CAMERA_USERNAME || 'admin',
  password: process.env.CAMERA_PASSWORD || 'admin123',
  port: parseInt(process.env.CAMERA_PORT) || 80
};

// AI Provider Configuration
const AI_PROVIDER = process.env.AI_PROVIDER || 'ollama'; // 'ollama' or 'chatgpt'

// AI Vision configuration
const AI_CONFIG = {
  model: 'qwen2.5vl:3b',
  analysisInterval: 1000, // Analyze every 5 seconds
  confidenceThreshold: 0.7,
  maxRetries: 3
};

// Voice processing configuration
const VOICE_CONFIG = {
  sampleRate: 16000,
  channels: 1,
  threshold: 0.1, // Audio level threshold for voice detection
  silenceTimeout: 2000, // Stop recording after 2 seconds of silence
  recordingDuration: 5000 // Maximum recording duration in ms
};

// Wake word detection configuration
const WAKE_WORD_CONFIG = {
  wakePhrase: 'jarvis',
  sampleRate: 16000,
  channels: 1,
  threshold: 0.05, // Lower threshold for wake word detection
  silenceTimeout: 1000, // Shorter silence timeout for wake detection
  recordingDuration: 3000, // Shorter recording for wake word
  enabled: true // Enable/disable wake word detection
};

let rtspStream = null;
let visionAnalysisActive = false;
let lastAnalysisTime = 0;
let aiAnalysisInProgress = false;
let gestureInProgress = false;
let voiceRecordingActive = false;
let currentAudioStream = null;

console.log('🔍 Connecting to Amcrest camera...');
console.log(`📍 IP: ${cameraConfig.hostname}`);
console.log(`👤 Username: ${cameraConfig.username}`);
console.log(`🤖 AI Provider: ${AI_PROVIDER.toUpperCase()}`);

// Initialize AI clients
let openai = null;
if (AI_PROVIDER === 'chatgpt') {
  openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
  });
  console.log('🤖 Initializing AI Vision with ChatGPT...');
} else {
  console.log('🤖 Initializing AI Vision with Ollama...');
}

// Initialize AI connection
async function initializeAI() {
  if (AI_PROVIDER === 'chatgpt') {
    try {
      console.log('🧠 Checking ChatGPT connection...');
      // Test the connection with a simple request
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 5
      });
      console.log('✅ ChatGPT connection successful!');
      return true;
    } catch (error) {
      console.error('❌ Failed to connect to ChatGPT:', error.message);
      console.log('💡 Make sure your OpenAI API key is valid');
      return false;
    }
  } else {
    try {
      console.log('🧠 Checking Ollama connection...');
      const models = await ollama.list();
      console.log('📋 Available models:', models.models.map(m => m.name));
      
      // Check if qwen2.5vl:3b is available
      const hasQwenModel = models.models.some(m => m.name.includes('qwen2.5vl:3b'));
      if (!hasQwenModel) {
        console.log('⚠️  qwen2.5vl:3b model not found. Please install it with: ollama pull qwen2.5vl:3b');
        console.log('🔄 Falling back to llama3.2-vision model...');
        AI_CONFIG.model = 'llama3.2-vision';
      } else {
        console.log('✅ qwen2.5vl:3b model found!');
      }
      
      return true;
    } catch (error) {
      console.error('❌ Failed to connect to Ollama:', error.message);
      console.log('💡 Make sure Ollama is running: ollama serve');
      return false;
    }
  }
}

// Capture frame from RTSP stream and convert to base64
async function captureFrame(rtspUrl) {
  return new Promise((resolve, reject) => {
    try {
      const outputPath = './temp_frame.jpg';
      
      // Use ffmpeg to capture a single frame from RTSP stream
      const ffmpegArgs = [
        '-i', rtspUrl,
        '-vframes', '1',
        '-f', 'image2',
        '-y', // Overwrite output file
        outputPath
      ];
      
      console.log('      📹 Capturing frame with ffmpeg...');
      
      const ffmpeg = spawn('ffmpeg', ffmpegArgs, {
        stdio: ['ignore', 'pipe', 'pipe']
      });
      
      let stderr = '';
      
      ffmpeg.stderr.on('data', (data) => {
        stderr += data.toString();
      });
      
      ffmpeg.on('close', async (code) => {
        if (code === 0 && fs.existsSync(outputPath)) {
          try {
            // Use sharp to process the image and convert to base64
            const imageBuffer = await sharp(outputPath)
              .resize(640, 480, { fit: 'inside' }) // Resize for better performance
              .jpeg({ quality: 80 })
              .toBuffer();
            
            const base64String = imageBuffer.toString('base64');
            
            // Clean up
            fs.unlinkSync(outputPath);
            
            console.log('      ✅ Frame captured and processed successfully');
            resolve(base64String);
          } catch (error) {
            console.error('      ❌ Error processing image:', error.message);
            reject(error);
          }
        } else {
          console.error('      ❌ FFmpeg failed:', stderr);
          reject(new Error(`FFmpeg failed with code ${code}: ${stderr}`));
        }
      });
      
      ffmpeg.on('error', (error) => {
        console.error('      ❌ FFmpeg error:', error.message);
        reject(error);
      });
      
    } catch (error) {
      reject(error);
    }
  });
}

// Unified AI chat function that works with both Ollama and ChatGPT
async function aiChat(messages) {
  try {
    if (AI_PROVIDER === 'chatgpt') {
      console.log('🤖 Using ChatGPT for AI analysis...');
      
      // Convert messages for ChatGPT format
      const chatGptMessages = messages.map(msg => {
        if (msg.images && msg.images.length > 0) {
          // Convert base64 to proper format for ChatGPT
          return {
            role: msg.role,
            content: [
              {
                type: 'text',
                text: msg.content
              },
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/jpeg;base64,${msg.images[0]}`
                }
              }
            ]
          };
        } else {
          return {
            role: msg.role,
            content: msg.content
          };
        }
      });
      
      console.log('📤 Sending to ChatGPT:', {
        model: 'gpt-4o',
        messageCount: chatGptMessages.length,
        hasImage: chatGptMessages.some(msg => msg.content && Array.isArray(msg.content) && msg.content.some(c => c.type === 'image_url'))
      });
      
      const response = await openai.chat.completions.create({
        model: 'gpt-4o', // Use vision-capable model
        messages: chatGptMessages,
        max_tokens: 50,
        temperature: 0.1
      });
      
      console.log('📥 ChatGPT response:', response.choices[0].message.content);
      return response.choices[0].message.content;
    } else {
      console.log('🤖 Using Ollama for AI analysis...');
      const response = await ollama.chat({
        model: AI_CONFIG.model,
        messages: messages,
        stream: false
      });
      return response.message.content;
    }
  } catch (error) {
    console.error('❌ AI chat failed:', error.message);
    return null;
  }
}

// Analyze image with AI Vision model
async function analyzeImage(imageBase64) {
  try {
    console.log('🔍 Analyzing image with AI...');
    
    const messages = [
      {
        role: 'system',
        content: 'You are a helpful AI assistant that analyzes security camera footage. Describe what you see in a clear, concise manner using no more than 6 words. Focus on people, objects, activities, and any potential security concerns. Keep descriptions brief but informative.'
      },
      {
        role: 'user',
        content: 'What do you see in this security camera image?',
        images: [imageBase64]
      }
    ];
    
    return await aiChat(messages);
  } catch (error) {
    console.error('❌ AI analysis failed:', error.message);
    return null;
  }
}

// Start AI vision analysis (disabled - only for voice questions)
async function startVisionAnalysis(rtspUrl) {
  console.log('👁️  AI Vision Analysis ready (only for voice questions)...');
  console.log('📊 No continuous analysis - only responds to voice questions');
  console.log('🎤 Press "V" to ask a question and get AI response with gestures!');
}

// Announce vision results (no automatic gestures)
function announceVisionResult(analysis) {
  console.log('📢 Vision Announcement:', analysis);
  
  // Here you could integrate with text-to-speech
  // For now, we'll just log it
  const timestamp = new Date().toLocaleTimeString();
  console.log(`🕐 [${timestamp}] Camera sees: ${analysis}`);
  
  // No automatic gestures - only respond to user questions
  console.log('🤖 Camera is observing... Press "V" to ask a question!');
}

// Start voice recording for user questions
async function startVoiceRecording() {
  if (voiceRecordingActive) {
    console.log('🎤 Voice recording already active');
    return;
  }
  
  voiceRecordingActive = true;
  console.log('🎤 Starting voice recording... Speak your question now!');
  console.log('🎤 Speak clearly into the camera microphone...');
  
  try {
    // Use camera microphone recording (which we know works well)
    const audioFile = await recordAudioFromCamera();
    if (audioFile) {
      await processVoiceInput(null, audioFile);
    } else {
      console.log('❌ No audio recorded from camera microphone');
    }
  } catch (error) {
    console.log('❌ Camera microphone recording failed:', error.message);
  } finally {
    // Always reset the flag when done
    voiceRecordingActive = false;
    console.log('🎤 Voice recording session ended');
  }
}

// Start local microphone recording
function startLocalRecording() {
  console.log('🎤 Starting local microphone recording...');
  console.log('🎤 Recording config:', {
    sampleRate: VOICE_CONFIG.sampleRate,
    threshold: VOICE_CONFIG.threshold,
    silence: VOICE_CONFIG.silenceTimeout,
    duration: VOICE_CONFIG.recordingDuration
  });
  
  const recording = record.record({
    sampleRateHertz: VOICE_CONFIG.sampleRate,
    threshold: VOICE_CONFIG.threshold,
    silence: VOICE_CONFIG.silenceTimeout,
    recordProgram: 'rec' // Use 'rec' command for recording
  });
  
  const audioChunks = [];
  
  recording.stream()
    .on('data', (chunk) => {
      audioChunks.push(chunk);
      console.log('🎤 Audio chunk received:', chunk.length, 'bytes');
    })
    .on('end', async () => {
      console.log('🎤 Local voice recording completed');
      console.log('🎤 Total audio chunks:', audioChunks.length);
      voiceRecordingActive = false;
      
      if (audioChunks.length > 0) {
        const audioBuffer = Buffer.concat(audioChunks);
        console.log('🎤 Total audio buffer size:', audioBuffer.length, 'bytes');
        await processVoiceInput(audioBuffer);
      } else {
        console.log('⚠️  No audio data recorded');
      }
    })
    .on('error', (error) => {
      console.error('❌ Local voice recording error:', error.message);
      voiceRecordingActive = false;
    });
  
  currentAudioStream = recording;
  
  // Stop recording after maximum duration
  setTimeout(() => {
    if (voiceRecordingActive) {
      console.log('⏰ Voice recording timeout reached');
      recording.stop();
    }
  }, VOICE_CONFIG.recordingDuration);
}

// Process voice input and convert to text
async function processVoiceInput(audioBuffer, audioFile = null) {
  try {
    console.log('🔊 Processing voice input...');
    
    let tempAudioFile = audioFile;
    
    if (audioBuffer && !audioFile) {
      // Save audio buffer to temporary file
      tempAudioFile = './temp_voice.wav';
      fs.writeFileSync(tempAudioFile, audioBuffer);
    }
    
    // Convert speech to text using a simple approach
    // For now, we'll use a placeholder - you can integrate with Whisper API or similar
    const userQuestion = await convertSpeechToText(tempAudioFile);
    
    if (userQuestion) {
      console.log('🎤 User question:', userQuestion);
      await handleUserQuestion(userQuestion);
    }
    
    // Clean up
    if (tempAudioFile && fs.existsSync(tempAudioFile)) {
      fs.unlinkSync(tempAudioFile);
    }
    
  } catch (error) {
    console.error('❌ Voice processing error:', error.message);
  }
}

// Convert speech to text using real speech recognition
async function convertSpeechToText(audioFile) {
  console.log('🔤 *** ENTERING convertSpeechToText function ***');
  console.log('🔤 Converting speech to text...');
        console.log('      📁 Input audio file:', audioFile);
      console.log('      📁 Input file exists:', fs.existsSync(audioFile));
      console.log('      📁 Input file size:', fs.existsSync(audioFile) ? fs.statSync(audioFile).size : 'N/A', 'bytes');
      
      try {
        // Check if the input file is already WAV format
        const isWavFile = audioFile.toLowerCase().endsWith('.wav');
        let wavFile = audioFile;
        
        if (!isWavFile) {
          // Convert AAC to WAV format for better compatibility
          wavFile = audioFile.replace('.g711a', '.wav');
          console.log('      🔄 Converting AAC to WAV:', wavFile);
      
          // Use ffmpeg to convert AAC to WAV
          const { spawn } = require('child_process');
          console.log('      🔧 FFmpeg command:', 'ffmpeg', '-f', 'aac', '-i', audioFile, '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1', '-y', wavFile);
          
          const ffmpeg = spawn('ffmpeg', [
            '-f', 'aac',  // Force AAC format
            '-i', audioFile,
            '-acodec', 'pcm_s16le',
            '-ar', '16000',
            '-ac', '1',
            '-y', // Overwrite
            wavFile
          ]);
        
        let stderr = '';
        let stdout = '';
        ffmpeg.stderr.on('data', (data) => {
          stderr += data.toString();
        });
        ffmpeg.stdout.on('data', (data) => {
          stdout += data.toString();
        });
    
            await new Promise((resolve, reject) => {
          ffmpeg.on('close', (code) => {
            console.log('      🔧 FFmpeg exit code:', code);
            console.log('      🔧 FFmpeg stdout:', stdout);
            console.log('      🔧 FFmpeg stderr:', stderr);
            if (code === 0) {
              console.log('      ✅ Audio converted to WAV format');
              // Add a small delay to ensure file system sync
              setTimeout(() => {
                console.log('      ⏱️  Waiting for file system sync...');
                resolve();
              }, 100);
            } else {
              console.log('      ❌ FFmpeg conversion failed with code', code);
              reject(new Error(`FFmpeg conversion failed with code ${code}`));
            }
          });
      
      ffmpeg.on('error', (error) => {
        console.log('      ❌ FFmpeg error:', error.message);
        reject(error);
      });
    });
        } else {
          console.log('      ✅ Input file is already WAV format, no conversion needed');
        }
    
        // Try to use whisper-node for speech recognition
        try {
          // Capture working directory BEFORE loading whisper-node (which changes it)
          const originalCwd = process.cwd();
          console.log('      📁 Original working directory:', originalCwd);
          
          console.log('      🧠 Loading Whisper model...');
          const { whisper } = require('whisper-node');
          
          console.log('      🎤 Starting speech recognition...');
          
          // Use absolute path to ensure we're looking in the right directory
          const absoluteWavPath = require('path').resolve(originalCwd, wavFile);
          console.log('      📁 Absolute WAV file path:', absoluteWavPath);
          console.log('      📁 WAV file exists:', fs.existsSync(absoluteWavPath));
          if (fs.existsSync(absoluteWavPath)) {
            console.log('      📁 WAV file size:', fs.statSync(absoluteWavPath).size, 'bytes');
          }
      
                // Add timeout to prevent hanging
          const whisperPromise = whisper(absoluteWavPath, {
            language: 'en',
            modelName: 'tiny' // Use the tiny model that we know works
          });
      
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Whisper timeout after 10 seconds')), 10000);
      });
      
      const result = await Promise.race([whisperPromise, timeoutPromise]);
      
            console.log('      📊 Whisper result:', result);
      console.log('      📊 Whisper result type:', typeof result);
      
      // Clean up the temporary WAV file
      if (fs.existsSync(absoluteWavPath)) {
        fs.unlinkSync(absoluteWavPath);
        console.log('      🧹 Cleaned up WAV file');
      }
      
      // Extract text from Whisper result (it returns an array of segments)
      let transcribedText = '';
      if (result && Array.isArray(result)) {
        transcribedText = result.map(segment => segment.speech).join(' ').trim();
        console.log('      📊 Extracted text from segments:', transcribedText);
      } else if (result && result.text) {
        transcribedText = result.text;
        console.log('      📊 Using result.text:', transcribedText);
      }
      
      if (transcribedText && transcribedText.length > 0) {
        console.log('🎤 Transcribed text:', transcribedText);
        return transcribedText;
      } else {
        console.log('⚠️  No speech detected or recognition failed');
        return 'No speech detected';
      }
      
    } catch (whisperError) {
      console.log('❌ Whisper error:', whisperError.message);
      console.log('      🔍 Whisper error details:', whisperError);
      
      // Fallback: analyze audio characteristics
      try {
        console.log('      📊 Falling back to audio analysis...');
        const { spawn } = require('child_process');
        
        // Use ffmpeg to analyze audio characteristics
        const analyze = spawn('ffmpeg', [
          '-i', wavFile,
          '-af', 'volumedetect',
          '-f', 'null',
          '-'
        ], { stdio: 'pipe' });
        
        let stderr = '';
        analyze.stderr.on('data', (data) => {
          stderr += data.toString();
        });
        
        await new Promise((resolve, reject) => {
          analyze.on('close', (code) => {
            if (code === 0 || code === 1) { // ffmpeg returns 1 for analysis
              console.log('      📊 Audio analysis completed');
              resolve();
            } else {
              reject(new Error(`Audio analysis failed`));
            }
          });
        });
        
        // Clean up the temporary WAV file
        if (fs.existsSync(wavFile)) {
          fs.unlinkSync(wavFile);
        }
        
        // Check if there's significant audio content
        if (stderr.includes('mean_volume') && !stderr.includes('mean_volume: -inf dB')) {
          console.log('🎤 Audio detected with speech content');
          return 'Speech detected but transcription unavailable';
        } else {
          console.log('⚠️  No significant audio content detected');
          return 'No speech detected';
        }
        
      } catch (fallbackError) {
        console.log('❌ Fallback analysis also failed:', fallbackError.message);
        return 'Audio recorded but could not be transcribed';
      }
    }
    
  } catch (error) {
    console.log('❌ Speech recognition error:', error.message);
    console.log('      🔍 Error details:', error);
    return 'Audio recorded but speech recognition failed';
  }
}

// Alternative: Capture audio from RTSP stream
async function captureAudioFromRTSP(rtspUrl) {
  return new Promise((resolve, reject) => {
    try {
      const outputPath = './temp_audio.wav';
      
      // Use ffmpeg to extract audio from RTSP stream
      const ffmpegArgs = [
        '-i', rtspUrl,
        '-vn', // No video
        '-acodec', 'pcm_s16le', // Audio codec
        '-ar', '16000', // Sample rate
        '-ac', '1', // Mono
        '-t', '5', // 5 seconds duration
        '-y', // Overwrite
        outputPath
      ];
      
      console.log('      🎵 Capturing audio from RTSP...');
      
      const ffmpeg = spawn('ffmpeg', ffmpegArgs, {
        stdio: ['ignore', 'pipe', 'pipe']
      });
      
      let stderr = '';
      
      ffmpeg.stderr.on('data', (data) => {
        stderr += data.toString();
      });
      
      ffmpeg.on('close', (code) => {
        if (code === 0 && fs.existsSync(outputPath)) {
          console.log('      ✅ Audio captured successfully');
          resolve(outputPath);
        } else {
          console.error('      ❌ Audio capture failed:', stderr);
          reject(new Error(`Audio capture failed with code ${code}`));
        }
      });
      
      ffmpeg.on('error', (error) => {
        console.error('      ❌ Audio capture error:', error.message);
        reject(error);
      });
      
    } catch (error) {
      reject(error);
    }
  });
}

// Test microphone and speaker with record and playback using Amcrest API
async function testMicrophoneAndSpeaker() {
  console.log('\n🎤 Testing microphone and speaker using Amcrest API...');
  
  try {
    // Step 1: Record audio from camera microphone using getAudio
    console.log('📹 Recording 5 seconds of audio from camera microphone...');
    console.log('🎤 Speak something into the camera microphone now!');
    
    const audioFile = await recordAudioFromCamera();
    
    if (audioFile && fs.existsSync(audioFile)) {
      console.log('✅ Audio recording completed!');
      console.log(`📁 Audio file saved: ${audioFile} (${fs.statSync(audioFile).size} bytes)`);
      
      // Step 2: Play back the recorded audio through camera speaker
      console.log('🔊 Playing back recorded audio through camera speaker...');
      console.log('🔧 DEBUG: About to call playAudioThroughCamera function');
      await playAudioThroughCamera(audioFile);
      console.log('🔧 DEBUG: playAudioThroughCamera completed');
      
      // Step 3: Try to convert speech to text
      console.log('🎤 Attempting speech-to-text conversion...');
      console.log('🔧 DEBUG: About to call convertSpeechToText function');
      try {
        const transcribedText = await convertSpeechToText(audioFile);
        console.log('📝 Transcribed text:', transcribedText);
        console.log('🔧 DEBUG: Speech-to-text completed successfully');
      } catch (sttError) {
        console.log('⚠️  Speech-to-text failed:', sttError.message);
        console.log('🔧 DEBUG: Speech-to-text error details:', sttError);
      }
      
      // Step 4: Clean up
      if (fs.existsSync(audioFile)) {
        fs.unlinkSync(audioFile);
        console.log('🧹 Cleaned up temporary audio file');
      }
    } else {
      console.log('⚠️  No audio file was created or file is empty');
    }
    
  } catch (error) {
    console.error('❌ Microphone/speaker test failed:', error.message);
  }
}

// Record audio from camera using Amcrest getAudio API
async function recordAudioFromCamera() {
  return new Promise((resolve, reject) => {
    try {
      const http = require('http');
      const crypto = require('crypto');
      const outputPath = './temp_audio.g711a';
      
      // First request to get digest challenge
      const initialOptions = {
        hostname: cameraConfig.hostname,
        port: cameraConfig.port,
        path: '/cgi-bin/audio.cgi?action=getAudio&httptype=singlepart&channel=1',
        method: 'GET',
        headers: {
          'User-Agent': 'Amcrest-Camera-Client/1.0'
        }
      };
      
      console.log('      🎵 Recording audio from camera microphone...');
      console.log(`      🔐 Auth: ${cameraConfig.username}:${cameraConfig.password}`);
      console.log(`      🌐 URL: http://${cameraConfig.hostname}:${cameraConfig.port}${initialOptions.path}`);
      
      const initialReq = http.request(initialOptions, (res) => {
        console.log(`      📡 Initial HTTP Response: ${res.statusCode}`);
        
        if (res.statusCode === 401 && res.headers['www-authenticate']) {
          // Parse digest challenge
          const authHeader = res.headers['www-authenticate'];
          console.log(`      🔐 Digest challenge: ${authHeader}`);
          
          // Extract digest parameters
          const realm = authHeader.match(/realm="([^"]+)"/)?.[1];
          const nonce = authHeader.match(/nonce="([^"]+)"/)?.[1];
          const qop = authHeader.match(/qop="([^"]+)"/)?.[1];
          const opaque = authHeader.match(/opaque="([^"]+)"/)?.[1];
          
          if (realm && nonce) {
            // Generate digest response
            const cnonce = crypto.randomBytes(16).toString('hex');
            const nc = '00000001';
            const uri = initialOptions.path;
            const method = 'GET';
            
            // Calculate digest response
            const ha1 = crypto.createHash('md5').update(`${cameraConfig.username}:${realm}:${cameraConfig.password}`).digest('hex');
            const ha2 = crypto.createHash('md5').update(`${method}:${uri}`).digest('hex');
            
            let response;
            if (qop === 'auth') {
              response = crypto.createHash('md5').update(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`).digest('hex');
            } else {
              response = crypto.createHash('md5').update(`${ha1}:${nonce}:${ha2}`).digest('hex');
            }
            
            // Build digest authorization header
            let digestAuth = `Digest username="${cameraConfig.username}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"`;
            if (opaque) digestAuth += `, opaque="${opaque}"`;
            if (qop) digestAuth += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
            
            console.log(`      🔐 Digest auth: ${digestAuth}`);
            
            // Make authenticated request
            const authOptions = {
              hostname: cameraConfig.hostname,
              port: cameraConfig.port,
              path: '/cgi-bin/audio.cgi?action=getAudio&httptype=singlepart&channel=1',
              method: 'GET',
              headers: {
                'Authorization': digestAuth,
                'User-Agent': 'Amcrest-Camera-Client/1.0'
              }
            };
            
            const authReq = http.request(authOptions, (authRes) => {
              console.log(`      📡 Authenticated HTTP Response: ${authRes.statusCode}`);
              console.log(`      📡 Headers:`, authRes.headers);
              
              if (authRes.statusCode === 200) {
                const fileStream = fs.createWriteStream(outputPath);
                let audioData = Buffer.alloc(0);
                
                authRes.on('data', (chunk) => {
                  audioData = Buffer.concat([audioData, chunk]);
                });
                
                // Stop recording after 5 seconds
                setTimeout(() => {
                  authReq.destroy();
                  console.log('      ⏱️  Recording stopped after 5 seconds');
                  
                  if (audioData.length > 0) {
                    fileStream.write(audioData);
                    fileStream.end();
                    console.log(`      ✅ Audio recording completed! (${audioData.length} bytes)`);
                    resolve(outputPath);
                  } else {
                    fileStream.end();
                    console.log('      ⚠️  No audio data received');
                    reject(new Error('No audio data received'));
                  }
                }, 5000);
                
              } else {
                console.error('      ❌ Audio recording failed:', authRes.statusCode);
                reject(new Error(`Audio recording failed with status ${authRes.statusCode}`));
              }
            });
            
            authReq.on('error', (error) => {
              console.error('      ❌ Authenticated request error:', error.message);
              reject(error);
            });
            
            authReq.end();
            
          } else {
            console.error('      ❌ Could not parse digest challenge');
            reject(new Error('Could not parse digest challenge'));
          }
          
        } else {
          console.error('      ❌ Unexpected response:', res.statusCode);
          reject(new Error(`Unexpected response: ${res.statusCode}`));
        }
      });
      
      initialReq.on('error', (error) => {
        console.error('      ❌ Initial request error:', error.message);
        reject(error);
      });
      
      initialReq.end();
      
    } catch (error) {
      reject(error);
    }
  });
}

// Play audio through camera speaker using Amcrest postAudio API
async function playAudioThroughCamera(audioFile) {
  return new Promise((resolve, reject) => {
    // Add timeout to prevent hanging
    const timeout = setTimeout(() => {
      console.log('      ⏱️  Audio playback timeout after 10 seconds');
      resolve(); // Don't reject, just resolve to continue
    }, 10000);
    try {
      const http = require('http');
      const crypto = require('crypto');
      
      // Read the audio file
      const audioData = fs.readFileSync(audioFile);
      console.log(`      📁 Audio file size: ${audioData.length} bytes`);
      
      // First request to get digest challenge
      const initialOptions = {
        hostname: cameraConfig.hostname,
        port: cameraConfig.port,
        path: '/cgi-bin/audio.cgi?action=postAudio&httptype=singlepart&channel=1',
        method: 'POST',
        headers: {
          'Content-Type': 'Audio/AAC',
          'Content-Length': audioData.length,
          'User-Agent': 'Amcrest-Camera-Client/1.0'
        }
      };
      
      console.log('      📡 Sending audio to camera speaker...');
      
      const initialReq = http.request(initialOptions, (res) => {
        console.log(`      📡 Initial HTTP Response: ${res.statusCode}`);
        
        if (res.statusCode === 401 && res.headers['www-authenticate']) {
          // Parse digest challenge
          const authHeader = res.headers['www-authenticate'];
          console.log(`      🔐 Digest challenge: ${authHeader}`);
          
          // Extract digest parameters
          const realm = authHeader.match(/realm="([^"]+)"/)?.[1];
          const nonce = authHeader.match(/nonce="([^"]+)"/)?.[1];
          const qop = authHeader.match(/qop="([^"]+)"/)?.[1];
          const opaque = authHeader.match(/opaque="([^"]+)"/)?.[1];
          
          if (realm && nonce) {
            // Generate digest response
            const cnonce = crypto.randomBytes(16).toString('hex');
            const nc = '00000001';
            const uri = initialOptions.path;
            const method = 'POST';
            
            // Calculate digest response
            const ha1 = crypto.createHash('md5').update(`${cameraConfig.username}:${realm}:${cameraConfig.password}`).digest('hex');
            const ha2 = crypto.createHash('md5').update(`${method}:${uri}`).digest('hex');
            
            let response;
            if (qop === 'auth') {
              response = crypto.createHash('md5').update(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`).digest('hex');
            } else {
              response = crypto.createHash('md5').update(`${ha1}:${nonce}:${ha2}`).digest('hex');
            }
            
            // Build digest authorization header
            let digestAuth = `Digest username="${cameraConfig.username}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"`;
            if (opaque) digestAuth += `, opaque="${opaque}"`;
            if (qop) digestAuth += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
            
            console.log(`      🔐 Digest auth: ${digestAuth}`);
            
            // Make authenticated request
            const authOptions = {
              hostname: cameraConfig.hostname,
              port: cameraConfig.port,
              path: '/cgi-bin/audio.cgi?action=postAudio&httptype=singlepart&channel=1',
              method: 'POST',
              headers: {
                'Content-Type': 'Audio/AAC',
                'Content-Length': audioData.length,
                'Authorization': digestAuth,
                'User-Agent': 'Amcrest-Camera-Client/1.0'
              }
            };
            
            const authReq = http.request(authOptions, (authRes) => {
              let responseData = '';
              
              authRes.on('data', (chunk) => {
                responseData += chunk.toString();
              });
              
              authRes.on('end', () => {
                console.log(`      📡 Authenticated HTTP Response: ${authRes.statusCode}`);
                console.log(`      📡 Response: ${responseData}`);
                
                if (authRes.statusCode === 200 && responseData.includes('OK')) {
                  console.log('      ✅ Audio sent to camera speaker successfully!');
                } else {
                  console.log('      ⚠️  Audio playback may not be supported or failed');
                }
                clearTimeout(timeout);
                resolve();
              });
            });
            
            authReq.on('error', (err) => {
              console.log('      ❌ Authenticated request error:', err.message);
              console.log('      💡 Camera may not support audio playback via HTTP');
              clearTimeout(timeout);
              resolve(); // Don't reject, just note that it's not supported
            });
            
            authReq.write(audioData);
            authReq.end();
            
                  } else {
          console.error('      ❌ Could not parse digest challenge');
          clearTimeout(timeout);
          resolve(); // Don't reject, just note the issue
        }
          
        } else {
          console.log(`      📡 Unexpected response: ${res.statusCode}`);
          clearTimeout(timeout);
          resolve(); // Don't reject, just note the issue
        }
      });
      
      initialReq.on('error', (err) => {
        console.log('      ❌ Initial request error:', err.message);
        console.log('      💡 Camera may not support audio playback via HTTP');
        clearTimeout(timeout);
        resolve(); // Don't reject, just note that it's not supported
      });
      
      initialReq.write(audioData);
      initialReq.end();
      
    } catch (error) {
      console.log('      ❌ Audio playback error:', error.message);
      clearTimeout(timeout);
      resolve(); // Don't reject, just note the error
    }
  });
}

// Handle user question with AI vision (optimized for speed)
async function handleUserQuestion(question) {
  try {
    console.log('🤖 Processing question with AI vision...');
    
    // Capture current frame
    const rtspUrl = `rtsp://${cameraConfig.username}:${cameraConfig.password}@${cameraConfig.hostname}:${cameraConfig.port}/cam/realmonitor?channel=1&subtype=0&unicast=true&proto=Onvif`;
    const imageBase64 = await captureFrame(rtspUrl);
    
    if (imageBase64) {
      // Send question and image to AI with optimized prompt
      const messages = [
        {
          role: 'system',
          content: AI_PROVIDER === 'chatgpt' 
            ? 'You are a camera assistant that answers yes/no questions about what you see. You MUST respond with ONLY "YES" or "NO" - no other text, no explanations, no punctuation. Just "YES" or "NO".'
            : 'You are a camera assistant that answers yes/no questions about what you see. Respond ONLY with "YES" or "NO" based on the image. Be direct and concise.'
        },
        {
          role: 'user',
          content: question,
          images: [imageBase64]
        }
      ];
      
      const answer = await aiChat(messages);
      if (answer) {
        const answerTrimmed = answer.trim();
        console.log('🤖 AI Answer:', answerTrimmed);
        
        // Determine gesture based on answer (case-insensitive)
        const answerLower = answerTrimmed.toLowerCase();
        if (answerLower === 'yes' || answerLower.includes('yes')) {
          console.log('✅ Answer is YES - Camera will nod in response');
          gestureInProgress = true;
          gestureYes(() => {
            console.log('✅ Camera nodded "YES" to your question');
            gestureInProgress = false;
          });
        } else if (answerLower === 'no' || answerLower.includes('no')) {
          console.log('❌ Answer is NO - Camera will shake in response');
          gestureInProgress = true;
          gestureNo(() => {
            console.log('✅ Camera shook "NO" to your question');
            gestureInProgress = false;
          });
        } else {
          console.log('🤔 Ambiguous answer - Camera will not gesture');
          console.log('💡 Try asking a yes/no question for a gesture response');
        }
      }
    }
  } catch (error) {
    console.error('❌ Question processing error:', error.message);
  }
}

// Start voice interaction system
function startVoiceInteraction() {
  console.log('\n🎤 Voice Interaction System Ready!');
  console.log('🤖 Camera is ready to answer yes/no questions with gestures...');
  console.log('💡 Press "V" for voice question, "T" for text question, "M" for mic test, "W" for wake word mode, "Q" to quit');
  
  // Set up keyboard listener
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  
  process.stdin.on('data', async (key) => {
    // Handle Ctrl+C (ASCII 3)
    if (key === '\u0003') {
      console.log('\n🛑 Ctrl+C detected - stopping application...');
      process.stdin.setRawMode(false);
      process.stdin.pause();
      stopVisionAnalysis();
      cam.stop(() => {
        console.log('👋 Demo stopped. Goodbye!');
        process.exit(0);
      });
      return;
    }
    
    if (key === 'v' || key === 'V') {
      console.log('\n🎤 Voice recording triggered! Speak your question now...');
      startVoiceRecording();
    } else if (key === 't' || key === 'T') {
      console.log('\n📝 Text input mode - Type your question and press Enter:');
      process.stdin.setRawMode(false);
      process.stdin.setEncoding('utf8');
      
      process.stdin.once('data', async (question) => {
        const cleanQuestion = question.toString().trim();
        console.log('🎤 Text question:', cleanQuestion);
        await handleUserQuestion(cleanQuestion);
        
        // Return to raw mode for keyboard shortcuts
        process.stdin.setRawMode(true);
        process.stdin.setEncoding('utf8');
        console.log('\n💡 Press "V" for voice, "T" for text, "M" for mic test, "Q" to quit');
      });
    } else if (key === 'm' || key === 'M') {
      console.log('\n🎤 Starting microphone and speaker test...');
      await testMicrophoneAndSpeaker();
      console.log('\n💡 Press "V" for voice, "T" for text, "M" for mic test, "W" for wake word mode, "Q" to quit');
    } else if (key === 'w' || key === 'W') {
      console.log('\n👂 Starting wake word detection mode...');
      console.log(`🎯 Say "${WAKE_WORD_CONFIG.wakePhrase}" to activate the camera!`);
      startWakeWordMode();
    } else if (key === 'q' || key === 'Q') {
      console.log('\n👋 Quitting...');
      process.stdin.setRawMode(false);
      process.stdin.pause();
      stopVisionAnalysis();
      process.exit(0);
    }
  });
}

// Wake word mode - continuously listen for wake word
async function startWakeWordMode() {
  console.log('👂 Wake word mode activated!');
  console.log(`🎯 Continuously listening for: "${WAKE_WORD_CONFIG.wakePhrase}"`);
  console.log('💡 Press any key to exit wake word mode');
  
  // Start continuous wake word detection
  await monitorForWakeWord();
}

// Monitor for wake word continuously
async function monitorForWakeWord() {
  let wakeWordActive = true;
  
  while (wakeWordActive) {
    try {
      console.log('👂 Listening for wake word...');
      
      // Record audio and check for wake word
      const audioFile = await recordAudioFromCamera();
      
      if (audioFile) {
        // Check if wake word is present
        const transcribedText = await convertSpeechToText(audioFile);
        
        if (transcribedText && transcribedText !== 'No speech detected') {
          const textLower = transcribedText.toLowerCase().trim();
          const wakePhraseLower = WAKE_WORD_CONFIG.wakePhrase.toLowerCase();
          
          console.log('🔍 Transcribed:', transcribedText);
          
          // Check for wake word variations (e.g., "jarvis", "jar vis", "journalist", "jar", "vis")
          const wakeWordDetected = textLower.includes(wakePhraseLower) || 
                                  textLower.includes('jar vis') ||
                                  textLower.includes('journalist') ||
                                  (textLower.includes('jar') && textLower.includes('vis'));
          
          if (wakeWordDetected) {
            console.log('🎯 Wake word detected! Processing question...');
            
            // Extract the question from the original audio (remove wake word)
            const questionStart = textLower.indexOf(wakePhraseLower) + wakePhraseLower.length;
            const questionText = transcribedText.substring(questionStart).trim();
            
            if (questionText && questionText !== '[ BLANK _ AUDIO ]') {
              console.log('🎤 Extracted question:', questionText);
              await handleUserQuestion(questionText);
            } else {
              console.log('❌ No question detected after wake word');
            }
            
            console.log('👂 Resuming wake word detection...');
          }
        }
        
        // Clean up audio file
        if (fs.existsSync(audioFile)) {
          fs.unlinkSync(audioFile);
        }
      }
      
      // Small delay before next check
      await new Promise(resolve => setTimeout(resolve, 1000));
      
    } catch (error) {
      console.error('❌ Wake word monitoring error:', error.message);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
}

// Stop AI vision analysis
function stopVisionAnalysis() {
  visionAnalysisActive = false;
  aiAnalysisInProgress = false;
  gestureInProgress = false;
  voiceRecordingActive = false;
  if (currentAudioStream) {
    currentAudioStream.stop();
    currentAudioStream = null;
  }
  console.log('⏹️  AI Vision Analysis stopped');
}

const cam = new Cam(cameraConfig, async function(err) {
  if (err) {
    console.error('❌ Failed to connect to camera:', err.message);
    process.exit(1);
  }
  
  console.log('✅ Successfully connected to camera!');
  
  // Initialize Ollama
  const aiReady = await initializeAI();
  if (!aiReady) {
    console.log('⚠️  Continuing without AI vision capabilities...');
  }
  
  // Get camera information
  console.log('\n📷 Camera Information:');
  console.log(`   Manufacturer: ${cam.hostname}`);
  console.log(`   Model: ${cam.name}`);
  console.log(`   Hardware ID: ${cam.hardwareId}`);
  console.log(`   Location: ${cam.location}`);
  
  // Get PTZ configuration
  cam.getConfigurations((err, configs) => {
    if (err) {
      console.error('❌ Failed to get PTZ configurations:', err.message);
      return;
    }
    
    console.log('\n🎮 PTZ Configurations found:', configs.length);
    
    // Get stream URI
    cam.getStreamUri({ protocol: 'RTSP' }, (err, res) => {
      if (!err) {
        console.log('\n📺 RTSP Stream URL:', res.uri);
        
        // Add authentication to RTSP URL
        const authenticatedRtspUrl = res.uri.replace('rtsp://', `rtsp://${cameraConfig.username}:${cameraConfig.password}@`);
        console.log('🔐 Authenticated RTSP URL:', authenticatedRtspUrl);
        
        // Start AI vision analysis if Ollama is ready
        if (aiReady) {
          console.log('\n🚀 Starting AI Vision Analysis...');
          startVisionAnalysis(authenticatedRtspUrl);
        }
        
        // Start voice interaction system
        startVoiceInteraction();
        
        // Start PTZ demo
        // startPersonalityDemo();
      } else {
        console.error('❌ Failed to get RTSP URL:', err.message);
        // startPersonalityDemo();
      }
    });
  });
});

// Check what audio capabilities the camera supports
function checkAudioCapabilities(callback) {
  console.log('\n🔊 Checking Audio Capabilities...');
  
  let audioChecks = 0;
  const totalChecks = 3;
  
  function checkComplete() {
    audioChecks++;
    if (audioChecks >= totalChecks) {
      console.log('   ✅ Audio capability check completed');
      if (callback) callback();
    }
  }
  
  // Check for audio sources (microphones)
  cam.getAudioSources((err, sources) => {
    if (!err && sources && sources.length > 0) {
      console.log('   🎤 Audio Sources found:', sources.length);
      sources.forEach((source, index) => {
        console.log(`      ${index + 1}. ${source.name || 'Unknown'} (${source.token})`);
        if (source.configurations) {
          console.log(`         Configurations: ${source.configurations.length}`);
        }
      });
    } else {
      console.log('   ❌ No audio sources found or error:', err ? err.message : 'No sources');
    }
    checkComplete();
  });
  
  // Check for audio outputs (speakers)
  cam.getAudioOutputs((err, outputs) => {
    if (!err && outputs && outputs.length > 0) {
      console.log('   🔊 Audio Outputs found:', outputs.length);
      outputs.forEach((output, index) => {
        console.log(`      ${index + 1}. ${output.name || 'Unknown'} (${output.token})`);
        if (output.configurations) {
          console.log(`         Configurations: ${output.configurations.length}`);
        }
      });
    } else {
      console.log('   ❌ No audio outputs found or error:', err ? err.message : 'No outputs');
    }
    checkComplete();
  });
  
  // Check for audio encoder configurations
  cam.getAudioEncoderConfigurations((err, configs) => {
    if (!err && configs && configs.length > 0) {
      console.log('   🎵 Audio Encoder Configurations found:', configs.length);
      configs.forEach((config, index) => {
        console.log(`      ${index + 1}. ${config.name || 'Unknown'} (${config.token})`);
        if (config.encoding) {
          console.log(`         Encoding: ${config.encoding}`);
        }
        if (config.bitrate) {
          console.log(`         Bitrate: ${config.bitrate}`);
        }
        if (config.sampleRate) {
          console.log(`         Sample Rate: ${config.sampleRate}`);
        }
      });
    } else {
      console.log('   ❌ No audio encoder configurations found or error:', err ? err.message : 'No configs');
    }
    checkComplete();
  });
}


// Enhanced demo with personality gestures
function startPersonalityDemo() {
  console.log('\n🎭 Starting Personality Demo...');
  console.log('🤖 Watch the device show some personality!');
  
  const personalitySequence = [
    { name: 'Pan Right', x: 0.3, y: 0.0, zoom: 0.0 },
    { name: 'Pan Left', x: -0.3, y: 0.0, zoom: 0.0 },
    { name: 'Tilt Up', x: 0.0, y: 0.3, zoom: 0.0 },
    { name: 'Tilt Down', x: 0.0, y: -0.3, zoom: 0.0 },
    { name: 'Return to Center', x: 0.0, y: 0.0, zoom: 0.0 }
  ];
  
  let currentIndex = 0;
  
  function executeNextMovement() {
    if (currentIndex >= personalitySequence.length) {
      // After basic movements, do personality gestures
      console.log('\n🎭 Time for some personality!');
      
      // Do "yes" gesture
      gestureYes(() => {
        setTimeout(() => {
          // Do "no" gesture
          gestureNo(() => {
            console.log('\n✅ Personality Demo completed!');
            console.log('🤖 AI Vision Analysis will continue running...');
            console.log('💡 Press Ctrl+C to stop the application');
          });
        }, 2000);
      });
      return;
    }
    
    const movement = personalitySequence[currentIndex];
    console.log(`\n🔄 ${movement.name}...`);
    console.log(`   Pan: ${movement.x}, Tilt: ${movement.y}, Zoom: ${movement.zoom}`);
    
    cam.continuousMove(movement, (err) => {
      if (err) {
        console.error(`❌ Failed to execute ${movement.name}:`, err.message);
      } else {
        console.log(`   ✅ ${movement.name} started`);
      }
    });
    
    // Stop movement after 2 seconds
    setTimeout(() => {
      cam.stop((err) => {
        if (err) {
          console.error(`❌ Failed to stop ${movement.name}:`, err.message);
        } else {
          console.log(`   ⏹️  ${movement.name} stopped`);
        }
        
        // Wait 1 second before next movement
        setTimeout(() => {
          currentIndex++;
          executeNextMovement();
        }, 1000);
      });
    }, 2000);
  }
  
  // Start the personality demo sequence
  executeNextMovement();
}

// Gesture functions for personality
function gestureYes(callback) {
  console.log('\n🙂 Device says "YES" (nodding up and down)...');
  
  let nodCount = 0;
  const maxNods = 2;
  
  function performNod() {
    if (nodCount >= maxNods) {
      // Return to center
      cam.continuousMove({ x: 0.0, y: 0.0, zoom: 0.0 }, (err) => {
        if (err) {
          console.error('❌ Failed to return to center:', err.message);
        } else {
          console.log('   ✅ Returned to center');
        }
        
        setTimeout(() => {
          cam.stop(() => {
            console.log('   🎭 "Yes" gesture completed!');
            if (callback) callback();
          });
        }, 1000);
      });
      return;
    }
    
    console.log(`   Nod ${nodCount + 1}/${maxNods}: Tilting up...`);
    // Nod up - larger movement and longer duration
    cam.continuousMove({ x: 0.0, y: 0.3, zoom: 0.0 }, (err) => {
      if (err) {
        console.error('❌ Failed to nod up:', err.message);
        return;
      }
      
      setTimeout(() => {
        console.log(`   Nod ${nodCount + 1}/${maxNods}: Tilting down...`);
        // Nod down - larger movement and longer duration
        cam.continuousMove({ x: 0.0, y: -0.3, zoom: 0.0 }, (err) => {
          if (err) {
            console.error('❌ Failed to nod down:', err.message);
            return;
          }
          
          setTimeout(() => {
            nodCount++;
            performNod();
          }, 800);
        });
      }, 800);
    });
  }
  
  performNod();
}

function gestureNo(callback) {
  console.log('\n😐 Device says "NO" (shaking left and right)...');
  
  let shakeCount = 0;
  const maxShakes = 2;
  
  function performShake() {
    if (shakeCount >= maxShakes) {
      // Return to center
      cam.continuousMove({ x: 0.0, y: 0.0, zoom: 0.0 }, (err) => {
        if (err) {
          console.error('❌ Failed to return to center:', err.message);
        } else {
          console.log('   ✅ Returned to center');
        }
        
        setTimeout(() => {
          cam.stop(() => {
            console.log('   🎭 "No" gesture completed!');
            if (callback) callback();
          });
        }, 1000);
      });
      return;
    }
    
    console.log(`   Shake ${shakeCount + 1}/${maxShakes}: Panning left...`);
    // Shake left - larger movement and longer duration
    cam.continuousMove({ x: -0.3, y: 0.0, zoom: 0.0 }, (err) => {
      if (err) {
        console.error('❌ Failed to shake left:', err.message);
        return;
      }
      
      setTimeout(() => {
        console.log(`   Shake ${shakeCount + 1}/${maxShakes}: Panning right...`);
        // Shake right - larger movement and longer duration
        cam.continuousMove({ x: 0.3, y: 0.0, zoom: 0.0 }, (err) => {
          if (err) {
            console.error('❌ Failed to shake right:', err.message);
            return;
          }
          
          setTimeout(() => {
            shakeCount++;
            performShake();
          }, 800);
        });
      }, 800);
    });
  }
  
  performShake();
}

// Enhanced demo with personality gestures
function startPersonalityDemo() {
  console.log('\n🎭 Starting Personality Demo...');
  console.log('🤖 Watch the device show some personality!');
  
  const personalitySequence = [
    { name: 'Pan Right', x: 0.3, y: 0.0, zoom: 0.0 },
    { name: 'Pan Left', x: -0.3, y: 0.0, zoom: 0.0 },
    { name: 'Tilt Up', x: 0.0, y: 0.3, zoom: 0.0 },
    { name: 'Tilt Down', x: 0.0, y: -0.3, zoom: 0.0 },
    { name: 'Return to Center', x: 0.0, y: 0.0, zoom: 0.0 }
  ];
  
  let currentIndex = 0;
  
  function executeNextMovement() {
    if (currentIndex >= personalitySequence.length) {
      // After basic movements, do personality gestures
      console.log('\n🎭 Time for some personality!');
      
      // Do "yes" gesture
      gestureYes(() => {
        setTimeout(() => {
          // Do "no" gesture
          gestureNo(() => {
            console.log('\n✅ Personality Demo completed!');
            console.log('🤖 AI Vision Analysis will continue running...');
            console.log('💡 Press Ctrl+C to stop the application');
          });
        }, 2000);
      });
      return;
    }
    
    const movement = personalitySequence[currentIndex];
    console.log(`\n🔄 ${movement.name}...`);
    console.log(`   Pan: ${movement.x}, Tilt: ${movement.y}, Zoom: ${movement.zoom}`);
    
    cam.continuousMove(movement, (err) => {
      if (err) {
        console.error(`❌ Failed to execute ${movement.name}:`, err.message);
      } else {
        console.log(`   ✅ ${movement.name} started`);
      }
    });
    
    // Stop movement after 2 seconds
    setTimeout(() => {
      cam.stop((err) => {
        if (err) {
          console.error(`❌ Failed to stop ${movement.name}:`, err.message);
        } else {
          console.log(`   ⏹️  ${movement.name} stopped`);
        }
        
        // Wait 1 second before next movement
        setTimeout(() => {
          currentIndex++;
          executeNextMovement();
        }, 1000);
      });
    }, 2000);
  }
  
  // Start the personality demo sequence
  executeNextMovement();
}

// Handle process termination
process.on('SIGINT', () => {
  console.log('\n🛑 Stopping camera movements and AI vision...');
  stopVisionAnalysis();
  cam.stop(() => {
    console.log('👋 Demo stopped. Goodbye!');
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Stopping camera movements and AI vision...');
  stopVisionAnalysis();
  cam.stop(() => {
    console.log('👋 Demo stopped. Goodbye!');
    process.exit(0);
  });
});



