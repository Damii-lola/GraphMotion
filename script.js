// Import MotionCanvas from esm.sh CDN
import { makeScene2D, makeRectangle, makeText, makeCircle, createRef, useDuration, waitFor, waitUntil, useTime } from 'https://esm.sh/@motion-canvas/2d@latest';
import { all, createSignal, easeInOutCubic } from 'https://esm.sh/@motion-canvas/core@latest';

// Global reference to the current project
let currentProject = null;
let currentScene = null;

// Initialize MotionCanvas with a blank scene
function initMotionCanvas(canvas) {
  if (currentProject) {
    currentProject.dispose();
  }

  // Create a new project
  currentScene = makeScene2D(function* (view) {
    // Default: Show a placeholder
    const rect = makeRectangle({
      width: 200,
      height: 100,
      fill: '#6366f1',
    });
    
    const text = makeText({
      text: 'Your animation will appear here',
      fontSize: 20,
      fill: 'white',
    });
    
    yield view.add(rect);
    yield view.add(text);
    
    // Center the elements
    rect.position.set(0, 0);
    text.position.set(0, 0);
    
    // Simple animation
    yield* rect.scale(1.1, 1).to(1, 1);
  });

  currentProject = new Project({
    scenes: [currentScene],
    canvas,
  });
  
  currentProject.start();
}

// Load and run MotionCanvas code dynamically
function loadMotionCanvasCode(canvas, code) {
  if (currentProject) {
    currentProject.dispose();
  }

  try {
    // Create a new scene from the generated code
    // Note: This is a simplified approach. In production, you'd need to:
    // 1. Parse the code to extract the scene function
    // 2. Dynamically import and run it
    // For now, we'll use a basic scene with the user's prompt
    
    const scene = makeScene2D(function* (view) {
      const text = makeText({
        text: 'Rendering your animation...',
        fontSize: 24,
        fill: 'white',
      });
      
      yield view.add(text);
      text.position.set(0, 0);
      
      // Try to evaluate the generated code
      // WARNING: eval is used here for simplicity. In production, use a safer method.
      try {
        // Create a function from the code
        const sceneFunc = new Function('makeScene2D', 'makeRectangle', 'makeText', 'makeCircle', 'createRef', 'useDuration', 'waitFor', 'waitUntil', 'useTime', 'all', 'createSignal', 'easeInOutCubic', 'view',
          `return ${code}`
        );
        
        // Clear the current view
        yield* all(
          text.opacity(1, 0.5),
        );
        
        // Run the generated scene
        const generatedScene = sceneFunc(
          makeScene2D, makeRectangle, makeText, makeCircle, createRef, useDuration, waitFor, waitUntil, useTime, all, createSignal, easeInOutCubic, view
        );
        
        // For now, just show a success message
        text.text.set('Animation generated! (Check console for code)');
        
      } catch (e) {
        console.error('Error running generated code:', e);
        text.text.set('Error: Could not render animation');
      }
    });

    currentProject = new Project({
      scenes: [scene],
      canvas,
    });
    
    currentProject.start();
    
  } catch (error) {
    console.error('Error loading MotionCanvas:', error);
    alert('Error loading MotionCanvas: ' + error.message);
  }
}

// Generate video from prompt
async function generateVideo() {
  const prompt = document.getElementById('video-prompt').value;
  const status = document.getElementById('status');
  const generateBtn = document.getElementById('generate-btn');
  const canvas = document.getElementById('motion-canvas');

  if (!prompt) {
    status.textContent = 'Please enter a prompt!';
    return;
  }

  // Disable the button during generation
  generateBtn.disabled = true;
  generateBtn.textContent = 'Generating...';
  status.textContent = 'Generating animation code...';

  try {
    // Call your backend API to generate MotionCanvas code
    // NOTE: Update this URL to your deployed backend (e.g., https://your-render-app.onrender.com)
    const backendUrl = 'http://localhost:3000/api/generate-animation';
    
    const response = await fetch(backendUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ prompt }),
    });

    if (!response.ok) {
      throw new Error(`Backend error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    
    if (data.success && data.data && data.data.animation_code) {
      status.textContent = 'Rendering animation...';
      
      // Load the generated code into MotionCanvas
      loadMotionCanvasCode(canvas, data.data.animation_code);
      
      status.textContent = 'Done! Animation rendered.';
      console.log('Generated MotionCanvas code:', data.data.animation_code);
    } else {
      throw new Error(data.error || 'Failed to generate animation code');
    }
    
  } catch (error) {
    console.error('Error generating video:', error);
    status.textContent = 'Error: ' + error.message;
    alert('Error generating video. Check the console for details.');
  } finally {
    generateBtn.disabled = false;
    generateBtn.textContent = 'Generate Video';
  }
}

// Initialize on page load
window.addEventListener('load', () => {
  const canvas = document.getElementById('motion-canvas');
  if (canvas) {
    initMotionCanvas(canvas);
  }
  
  const generateBtn = document.getElementById('generate-btn');
  if (generateBtn) {
    generateBtn.addEventListener('click', generateVideo);
  }
});

// Project class (simplified for browser usage)
class Project {
  constructor({ scenes, canvas }) {
    this.scenes = scenes;
    this.canvas = canvas;
    this.currentScene = null;
  }

  async start() {
    if (this.scenes.length === 0) return;
    
    this.currentScene = this.scenes[0];
    
    // Simple rendering loop for demo purposes
    // In a real implementation, you'd use MotionCanvas's proper rendering
    const render = async () => {
      if (this.currentScene) {
        // This is a simplified approach
        // MotionCanvas normally handles this internally
        const generator = this.currentScene();
        for await (const _ of generator) {
          // Rendering would happen here
        }
      }
    };
    
    render();
  }

  dispose() {
    this.currentScene = null;
  }
}
