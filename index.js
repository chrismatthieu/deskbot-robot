const { Cam } = require('onvif');
const ollama = require('ollama').default;
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

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

let rtspStream = null;
let visionAnalysisActive = false;
let lastAnalysisTime = 0;
let aiAnalysisInProgress = false;
let gestureInProgress = false;

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

// Announce vision results and trigger gestures based on content
function announceVisionResult(analysis) {
  console.log('📢 Vision Announcement:', analysis);
  
  // Here you could integrate with text-to-speech
  // For now, we'll just log it
  const timestamp = new Date().toLocaleTimeString();
  console.log(`🕐 [${timestamp}] Camera sees: ${analysis}`);
  
  // Check if a person is detected and trigger appropriate gesture
  checkForPersonAndGesture(analysis);
}

// Check if analysis contains person-related keywords and trigger gesture
function checkForPersonAndGesture(analysis) {
  // Don't trigger gestures if one is already in progress
  if (gestureInProgress) {
    console.log('⏳ Gesture already in progress, skipping this detection');
    return;
  }
  
  const personKeywords = [
    'person', 'man', 'woman', 'boy', 'girl', 'child', 'people', 'human',
    'guy', 'lady', 'gentleman', 'someone', 'anyone', 'figure', 'individual'
  ];
  
  const analysisLower = analysis.toLowerCase();
  const hasPerson = personKeywords.some(keyword => analysisLower.includes(keyword));
  
  if (hasPerson) {
    console.log('👤 Person detected! Triggering "YES" gesture...');
    gestureInProgress = true;
    gestureYes(() => {
      console.log('✅ "YES" gesture completed for person detection');
      gestureInProgress = false;
    });
  } else {
    console.log('❌ No person detected. Triggering "NO" gesture...');
    gestureInProgress = true;
    gestureNo(() => {
      console.log('✅ "NO" gesture completed for no person detection');
      gestureInProgress = false;
    });
  }
}

// Stop AI vision analysis
function stopVisionAnalysis() {
  visionAnalysisActive = false;
  aiAnalysisInProgress = false;
  gestureInProgress = false;
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

