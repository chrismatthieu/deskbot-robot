# Amcrest PTZ Demo

A Node.js script that demonstrates PTZ (Pan, Tilt, Zoom) control of an Amcrest security camera using the ONVIF protocol.

## Prerequisites

- Node.js (version 14 or higher)
- An Amcrest security camera with ONVIF support
- Camera connected to your network with known IP address

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure camera settings:**
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

Run the PTZ demo:
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
2. **Display** camera information (manufacturer, model, etc.)
3. **Get** the RTSP stream URL for video streaming
4. **Execute** a sequence of PTZ movements:
   - Pan Right
   - Pan Left
   - Tilt Up
   - Tilt Down
   - Zoom In
   - Zoom Out
   - Diagonal Movement
   - Return to Center

Each movement lasts 2 seconds with a 1-second pause between movements.

## PTZ Movement Values

- **Pan (X-axis):** -1.0 (left) to +1.0 (right)
- **Tilt (Y-axis):** -1.0 (down) to +1.0 (up)
- **Zoom:** -1.0 (zoom out) to +1.0 (zoom in)

## Troubleshooting

### Connection Issues
- Verify your camera's IP address is correct
- Ensure the camera supports ONVIF
- Check that the username and password are correct
- Try different ports (80, 8080, 554)

### PTZ Not Working
- Some cameras require ONVIF to be enabled in settings
- Check if your camera model supports PTZ functionality
- Verify the camera is not in recording mode

### Common Error Messages
- `ECONNREFUSED`: Camera not reachable or wrong port
- `Unauthorized`: Wrong username/password
- `Not Found`: ONVIF service not available

## Stopping the Demo

Press `Ctrl+C` to stop the demo at any time. The script will gracefully stop any ongoing camera movements.

## Dependencies

- `onvif`: ONVIF protocol implementation for Node.js

## License

MIT

