#!/bin/bash

echo "🎥 Amcrest Camera AI System Setup"
echo "=================================="
echo ""

# Check if .env already exists
if [ -f ".env" ]; then
    echo "⚠️  .env file already exists!"
    read -p "Do you want to overwrite it? (y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Setup cancelled."
        exit 1
    fi
fi

# Copy example file
echo "📋 Copying .env.example to .env..."
cp .env.example .env

echo ""
echo "🔧 Please edit the .env file with your camera settings:"
echo "   nano .env"
echo ""
echo "Required settings to update:"
echo "   - CAMERA_HOSTNAME (your camera's IP address)"
echo "   - CAMERA_USERNAME (usually 'admin')"
echo "   - CAMERA_PASSWORD (your camera password)"
echo "   - OPENAI_API_KEY (if using ChatGPT)"
echo ""
echo "Optional settings:"
echo "   - AI_PROVIDER (ollama or chatgpt)"
echo "   - CAMERA_AUDIO_VOLUME (0-100)"
echo "   - WAKE_WORD_PHRASE (default: jarvis)"
echo ""

read -p "Press Enter to open .env file for editing..."
nano .env

echo ""
echo "✅ Setup complete!"
echo "🚀 Run 'node index.js' to start the application"
