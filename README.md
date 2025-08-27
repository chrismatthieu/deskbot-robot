# Amcrest PTZ Demo with AI Vision

A Node.js script that demonstrates PTZ (Pan, Tilt, Zoom) control of an Amcrest security camera using the ONVIF protocol, enhanced with AI vision capabilities using Ollama and Llama 3.2 Vision model.

## Features

- **PTZ Control**: Full pan, tilt, zoom control of your Amcrest camera
- **Personality Gestures**: "Yes" and "No" gestures with realistic movements
- **AI Vision Analysis**: Real-time object detection and scene analysis
- **Audio Capability Detection**: Checks for microphone and speaker support
- **RTSP Stream Integration**: Captures and analyzes video frames

## Prerequisites

- Node.js (version 14 or higher)
- An Amcrest security camera with ONVIF support
- Camera connected to your network with known IP address
- **Ollama** installed and running locally
- **Llama 3.2 Vision model** installed in Ollama

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Install Ollama:**
   ```bash
   # macOS/Linux
   curl -fsSL https://ollama.ai/install.sh | sh
   
   # Start Ollama
   ollama serve
   ```

3. **Install Llama 3.2 Vision model:**
   ```bash
   ollama pull llama3.2-vision
   ```

4. **Configure camera settings:**
   Edit `index.js` and update the camera configuration:
   ```javascript
   const cameraConfig = {
     hostname: '192.168.0.42',  // Your camera's IP address
     username: 'admin',         // Your camera's username
     password: 'V1ctor1a',      // Your camera's password
     port: 80                   // ONVIF port (usually 80 or 8080)
   };
   ```

## Usage

Run the enhanced PTZ demo with AI vision:
```bash
npm start
```

Or run directly:
```bash
node index.js
```

## What the Demo Does

The script will:

1. **Connect** to your Amcrest camera using ONVIF
2. **Initialize Ollama** and check for Llama 3.2 Vision model
3. **Display** camera information (manufacturer, model, etc.)
4. **Check** audio capabilities (microphones, speakers)
5. **Get** the RTSP stream URL for video streaming
6. **Start AI Vision Analysis** - analyzes video frames every 5 seconds
7. **Execute** a sequence of PTZ movements with personality gestures
8. **Continue** AI vision analysis after demo completion

## AI Vision Features

### Real-time Analysis
- Captures frames from RTSP stream every 5 seconds
- Analyzes images using Llama 3.2 Vision model
- Provides detailed descriptions of what the camera sees
- Focuses on people, objects, activities, and security concerns

### Configuration
You can adjust AI vision settings in the `AI_CONFIG` object:
```javascript
const AI_CONFIG = {
  model: 'llama3.2-vision',
  analysisInterval: 5000, // Analyze every 5 seconds
  confidenceThreshold: 0.7,
  maxRetries: 3
};
```

## PTZ Movement Values

- **Pan (X-axis):** -1.0 (left) to +1.0 (right)
- **Tilt (Y-axis):** -1.0 (down) to +1.0 (up)
- **Zoom:** -1.0 (zoom out) to +1.0 (zoom in)

## Personality Gestures

The camera demonstrates personality through:
- **"Yes" Gesture**: Nods up and down (tilt movements)
- **"No" Gesture**: Shakes left and right (pan movements)

## Troubleshooting

### Connection Issues
- Verify your camera's IP address is correct
- Ensure the camera supports ONVIF
- Check that the username and password are correct
- Try different ports (80, 8080, 554)

### Ollama Issues
- Make sure Ollama is running: `ollama serve`
- Install the vision model: `ollama pull llama3.2-vision`
- Check available models: `ollama list`

### PTZ Not Working
- Some cameras require ONVIF to be enabled in settings
- Check if your camera model supports PTZ functionality
- Verify the camera is not in recording mode

### AI Vision Issues
- Ensure RTSP stream is accessible
- Check that Ollama is running and accessible
- Verify the vision model is installed

### Common Error Messages
- `ECONNREFUSED`: Camera not reachable or wrong port
- `Unauthorized`: Wrong username/password
- `Not Found`: ONVIF service not available
- `Failed to connect to Ollama`: Ollama not running

## Stopping the Demo

Press `Ctrl+C` to stop the demo at any time. The script will gracefully stop:
- Any ongoing camera movements
- AI vision analysis
- RTSP stream processing

## Dependencies

- `onvif`: ONVIF protocol implementation for Node.js
- `ollama`: JavaScript client for Ollama AI models
- `node-rtsp-stream`: RTSP stream processing
- `jimp`: Image processing for frame capture

## License

MIT

