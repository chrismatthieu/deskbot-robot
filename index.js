const { Cam } = require('onvif');

// Camera configuration
const cameraConfig = {
  hostname: '192.168.0.42',
  username: 'admin',
  password: 'V1ctor1a',
  port: 80
};

console.log('🔍 Connecting to Amcrest camera...');
console.log(`📍 IP: ${cameraConfig.hostname}`);
console.log(`👤 Username: ${cameraConfig.username}`);

const cam = new Cam(cameraConfig, function(err) {
  if (err) {
    console.error('❌ Failed to connect to camera:', err.message);
    process.exit(1);
  }
  
  console.log('✅ Successfully connected to camera!');
  
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
      } else {
        console.error('❌ Failed to get RTSP URL:', err.message);
      }
      
      // Start PTZ demo
      startPTZDemo();
    });
  });
});

function startPTZDemo() {
  console.log('\n🎬 Starting PTZ Demo...');
  console.log('⏱️  Each movement will last 2 seconds');
  
  // Demo sequence
  const demoSequence = [
    { name: 'Pan Right', x: 0.3, y: 0.0, zoom: 0.0 },
    { name: 'Pan Left', x: -0.3, y: 0.0, zoom: 0.0 },
    { name: 'Tilt Up', x: 0.0, y: 0.3, zoom: 0.0 },
    { name: 'Tilt Down', x: 0.0, y: -0.3, zoom: 0.0 },
    // { name: 'Zoom In', x: 0.0, y: 0.0, zoom: 0.3 },
    // { name: 'Zoom Out', x: 0.0, y: 0.0, zoom: -0.3 },
    // { name: 'Diagonal Movement', x: 0.2, y: 0.2, zoom: 0.0 },
    { name: 'Return to Center', x: 0.0, y: 0.0, zoom: 0.0 }
  ];
  
  let currentIndex = 0;
  
  function executeNextMovement() {
    if (currentIndex >= demoSequence.length) {
      console.log('\n✅ PTZ Demo completed!');
      process.exit(0);
    }
    
    const movement = demoSequence[currentIndex];
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
  
  // Start the demo sequence
  executeNextMovement();
}

// Handle process termination
process.on('SIGINT', () => {
  console.log('\n🛑 Stopping camera movements...');
  cam.stop(() => {
    console.log('👋 Demo stopped. Goodbye!');
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Stopping camera movements...');
  cam.stop(() => {
    console.log('👋 Demo stopped. Goodbye!');
    process.exit(0);
  });
});

