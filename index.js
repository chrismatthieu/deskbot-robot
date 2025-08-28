const { Cam } = require('onvif');
const ollama = require('ollama').default;
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const record = require('node-record-lpcm16');

// Camera configuration
const cameraConfig = {
  hostname: '192.168.0.42',
  username: 'admin',
  password: 'V1ctor1a',
  port: 80
};

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
console.log('🤖 Initializing AI Vision with Ollama...');

// Initialize Ollama connection
async function initializeOllama() {
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

// Analyze image with Ollama Vision model
async function analyzeImage(imageBase64) {
  try {
    console.log('🔍 Analyzing image with AI...');
    
    const response = await ollama.chat({
      model: AI_CONFIG.model,
      messages: [
        {
          role: 'system',
          content: 'You are a helpful AI assistant that analyzes security camera footage. Describe what you see in a clear, concise manner using no more than 6 words. Focus on people, objects, activities, and any potential security concerns. Keep descriptions brief but informative.'
        },
        {
          role: 'user',
          content: 'What do you see in this security camera image?',
          images: [imageBase64]
        }
      ],
      stream: false
    });
    
    return response.message.content;
  } catch (error) {
    console.error('❌ AI analysis failed:', error.message);
    return null;
  }
}

// Start AI vision analysis
async function startVisionAnalysis(rtspUrl) {
  if (visionAnalysisActive) {
    console.log('⚠️  Vision analysis already active');
    return;
  }
  
  visionAnalysisActive = true;
  console.log('👁️  Starting AI Vision Analysis...');
  console.log(`📊 Analysis interval: ${AI_CONFIG.analysisInterval}ms`);
  
  const analysisLoop = async () => {
    if (!visionAnalysisActive) return;
    
    // Prevent overlapping AI requests
    if (aiAnalysisInProgress) {
      console.log('⏳ AI analysis in progress, skipping this cycle...');
      setTimeout(analysisLoop, 2000);
      return;
    }
    
    try {
      const now = Date.now();
      if (now - lastAnalysisTime < AI_CONFIG.analysisInterval) {
        setTimeout(analysisLoop, 1000);
        return;
      }
      
      lastAnalysisTime = now;
      aiAnalysisInProgress = true;
      console.log('\n📸 Capturing frame for analysis...');
      
      // Capture frame from RTSP stream
      const imageBase64 = await captureFrame(rtspUrl);
      
      if (imageBase64) {
        // Analyze with AI and wait for response
        const analysis = await analyzeImage(imageBase64);
        
        if (analysis) {
          console.log('🤖 AI Analysis Result:');
          console.log(`   ${analysis}`);
          
          // Announce the result (you could add text-to-speech here)
          announceVisionResult(analysis);
        }
        
        // Wait for the full analysis interval before next capture
        console.log(`⏱️  Waiting ${AI_CONFIG.analysisInterval}ms before next analysis...`);
        aiAnalysisInProgress = false;
        setTimeout(analysisLoop, AI_CONFIG.analysisInterval);
      } else {
        // If capture failed, retry sooner
        console.log('🔄 Frame capture failed, retrying in 2 seconds...');
        aiAnalysisInProgress = false;
        setTimeout(analysisLoop, 2000);
      }
      
    } catch (error) {
      console.error('❌ Vision analysis error:', error.message);
      // On error, retry sooner
      aiAnalysisInProgress = false;
      setTimeout(analysisLoop, 2000);
    }
  };
  
  analysisLoop();
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

// Handle user question with AI vision
async function handleUserQuestion(question) {
  try {
    console.log('🤖 Processing question with AI vision...');
    
    // Capture current frame
    const rtspUrl = `rtsp://${cameraConfig.username}:${cameraConfig.password}@${cameraConfig.hostname}:${cameraConfig.port}/cam/realmonitor?channel=1&subtype=0&unicast=true&proto=Onvif`;
    const imageBase64 = await captureFrame(rtspUrl);
    
    if (imageBase64) {
      // Send question and image to AI
      const response = await ollama.chat({
        model: AI_CONFIG.model,
        messages: [
          {
            role: 'system',
            content: 'You are a helpful AI assistant that answers questions. For questions about what you see in the image, use the image. For general knowledge questions, use your knowledge. Always respond with "YES" if the answer is affirmative, "NO" if negative, or provide a brief description. Be concise and direct.'
          },
          {
            role: 'user',
            content: question,
            images: [imageBase64]
          }
        ],
        stream: false
      });
      
      const answer = response.message.content;
      console.log('🤖 AI Answer:', answer);
      
      // Determine gesture based on answer
      const answerLower = answer.toLowerCase();
      if (answerLower.includes('yes') || answerLower.includes('affirmative') || answerLower.includes('true')) {
        console.log('✅ Answer is YES - Camera will nod in response');
        gestureInProgress = true;
        gestureYes(() => {
          console.log('✅ Camera nodded "YES" to your question');
          gestureInProgress = false;
        });
      } else if (answerLower.includes('no') || answerLower.includes('negative') || answerLower.includes('false')) {
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
    
  } catch (error) {
    console.error('❌ Question processing error:', error.message);
  }
}

// Start voice interaction system
function startVoiceInteraction() {
  console.log('\n🎤 Voice Interaction System Ready!');
  console.log('🤖 Camera is observing and waiting for your questions...');
  console.log('💡 Press "V" for voice question, "T" for text question, "M" for mic test, "Q" to quit');
  
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
      console.log('\n💡 Press "V" for voice, "T" for text, "M" for mic test, "Q" to quit');
    } else if (key === 'q' || key === 'Q') {
      console.log('\n👋 Quitting...');
      process.stdin.setRawMode(false);
      process.stdin.pause();
      stopVisionAnalysis();
      process.exit(0);
    }
  });
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
  const ollamaReady = await initializeOllama();
  if (!ollamaReady) {
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
        if (ollamaReady) {
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

// function startPTZDemo() {
//   console.log('\n🎬 Starting PTZ Demo...');
//   console.log('⏱️  Each movement will last 2 seconds');
  
//   // Demo sequence
//   const demoSequence = [
//     { name: 'Pan Right', x: 0.3, y: 0.0, zoom: 0.0 },
//     { name: 'Pan Left', x: -0.3, y: 0.0, zoom: 0.0 },
//     { name: 'Tilt Up', x: 0.0, y: 0.3, zoom: 0.0 },
//     { name: 'Tilt Down', x: 0.0, y: -0.3, zoom: 0.0 },
//     // { name: 'Zoom In', x: 0.0, y: 0.0, zoom: 0.3 },
//     // { name: 'Zoom Out', x: 0.0, y: 0.0, zoom: -0.3 },
//     // { name: 'Diagonal Movement', x: 0.2, y: 0.2, zoom: 0.0 },
//     { name: 'Return to Center', x: 0.0, y: 0.0, zoom: 0.0 }
//   ];
  
//   let currentIndex = 0;
  
//   function executeNextMovement() {
//     if (currentIndex >= demoSequence.length) {
//       console.log('\n✅ PTZ Demo completed!');
//       process.exit(0);
//     }
    
//     const movement = demoSequence[currentIndex];
//     console.log(`\n🔄 ${movement.name}...`);
//     console.log(`   Pan: ${movement.x}, Tilt: ${movement.y}, Zoom: ${movement.zoom}`);
    
//     cam.continuousMove(movement, (err) => {
//       if (err) {
//         console.error(`❌ Failed to execute ${movement.name}:`, err.message);
//       } else {
//         console.log(`   ✅ ${movement.name} started`);
//       }
//     });
    
//     // Stop movement after 2 seconds
//     setTimeout(() => {
//       cam.stop((err) => {
//         if (err) {
//           console.error(`❌ Failed to stop ${movement.name}:`, err.message);
//         } else {
//           console.log(`   ⏹️  ${movement.name} stopped`);
//         }
        
//         // Wait 1 second before next movement
//         setTimeout(() => {
//           currentIndex++;
//           executeNextMovement();
//         }, 1000);
//       });
//     }, 2000);
//   }
  
//   // Start the demo sequence
//   executeNextMovement();
// }

// Gesture functions for personality
function gestureYes(callback) {
  console.log('\n🙂 Device says "YES" (nodding up and down)...');
  
  let nodCount = 0;
  const maxNods = 3;
  
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
  const maxShakes = 3;
  
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



