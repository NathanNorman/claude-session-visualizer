const pptxgen = require('pptxgenjs');
const html2pptx = require('/Users/nathan.norman/.claude/plugins/cache/anthropic-agent-skills/document-skills/c74d647e56e6/document-skills/pptx/scripts/html2pptx');
const path = require('path');

async function createPresentation() {
    const pptx = new pptxgen();
    pptx.layout = 'LAYOUT_16x9';
    pptx.author = 'Claude';
    pptx.title = 'Claude Agent SDK Migration';
    pptx.subject = 'Mission Control Session Management Upgrade';

    const slidesDir = '/Users/nathan.norman/claude-session-visualizer/slides';
    const slideFiles = [
        'slide1.html',
        'slide2.html',
        'slide3.html',
        'slide4.html',
        'slide5.html',
        'slide6.html',
        'slide7.html'
    ];

    for (const file of slideFiles) {
        const htmlPath = path.join(slidesDir, file);
        console.log(`Processing ${file}...`);
        await html2pptx(htmlPath, pptx);
    }

    const outputPath = '/Users/nathan.norman/claude-session-visualizer/SDK_Migration_Demo.pptx';
    await pptx.writeFile({ fileName: outputPath });
    console.log(`Presentation saved to: ${outputPath}`);
}

createPresentation().catch(err => {
    console.error('Error creating presentation:', err);
    process.exit(1);
});
