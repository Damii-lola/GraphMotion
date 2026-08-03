// Motion Canvas setup
let project;

// Initialize Motion Canvas
async function initMotionCanvas() {
  const canvas = document.getElementById('motion-canvas');
  if (!canvas) return;

  // Load Motion Canvas
  const { makeProject, makeScene2D, makeRectangle, makeText } = window;
  
  project = makeProject({
    element: canvas,
    scenes: [makeScene2D()],
  });

  // Add a placeholder rectangle to the scene
  const scene = project.scenes[0];
  const rect = makeRectangle({
    width: 200,
    height: 100,
    fill: '#6366f1',
  });
  
  const text = makeText({
    text: 'Your video will appear here',
    fontSize: 20,
    fill: 'white',
  });
  
  scene.add(rect);
  scene.add(text);
  
  // Center the elements
  rect.position.set(0, 0);
  text.position.set(0, 0);
  
  // Start the project
  await project.start();
}

// Generate video from prompt
async function generateVideo() {
  const prompt = document.getElementById('video-prompt').value;
  if (!prompt) {
    alert('Please enter a prompt!');
    return;
  }

  // Disable the button during generation
  const generateBtn = document.getElementById('generate-btn');
  generateBtn.disabled = true;
  generateBtn.textContent = 'Generating...';

  try {
    // Call your backend API to generate Motion Canvas code
    const response = await fetch('http://localhost:3000/api/generate-animation', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ prompt }),
    });

    const data = await response.json();
    if (data.success && data.data.animation_code) {
      // Here you would dynamically load the generated Motion Canvas code
      // For now, we'll just log it
      console.log('Generated Motion Canvas code:', data.data.animation_code);
      
      // In a real implementation, you would:
      // 1. Parse the animation_code (which should be valid Motion Canvas code)
      // 2. Dynamically create a new project with the generated code
      // 3. Render it in the canvas
      
      alert('Video generated! Check the console for the Motion Canvas code.');
    } else {
      alert('Failed to generate video: ' + (data.error || 'Unknown error'));
    }
  } catch (error) {
    console.error('Error generating video:', error);
    alert('Error generating video. Check the console for details.');
  } finally {
    generateBtn.disabled = false;
    generateBtn.textContent = 'Generate Video';
  }
}

// Initialize on page load
window.addEventListener('load', () => {
  initMotionCanvas();
  
  // Set up generate button
  const generateBtn = document.getElementById('generate-btn');
  if (generateBtn) {
    generateBtn.addEventListener('click', generateVideo);
  }
});
