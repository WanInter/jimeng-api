# Jimeng API

[中文文档](README.CN.md)

🎨 **Free AI Image and Video Generation API Service** - Based on reverse engineering of Jimeng AI (China site) and Dreamina (international site).

[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/) [![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/) [![Docker](https://img.shields.io/badge/Docker-Supported-blue.svg)](https://www.docker.com/) [![License](https://img.shields.io/badge/License-GPL%20v3-blue.svg)](LICENSE)

## ✨ Features

- 🎨 **AI Image Generation**: Supports multiple models and resolutions (default 2K, supports 4K, 1K).
- 🖼️ **Image-to-Image Synthesis**: Supports local images or image URLs.
- 🎬 **AI Video Generation**: Supports text-to-video generation, and adds local image upload for image-to-video on the China site.
- 🌐 **International Site Support**: Added support for text-to-image and image-to-image APIs on Dreamina international sites. Open an issue if you run into problems.
- 💬 **Chat Completions API**: OpenAI-compatible `/v1/chat/completions` endpoint, automatically dispatching image/video models.
- 🖥️ **Management Dashboard**: Built-in web admin (SQLite-backed) for account management, API Key management, statistics, real-time logs, and media library.
- 📐 **Intelligent Ratio Detection**: Automatically infers the optimal aspect ratio from the prompt.
- ⬇️ **Auto Downgrade**: Automatically falls back to a lower resolution / shorter duration when credits are insufficient.
- 🔄 **Smart Polling**: Adaptive polling mechanism to optimize generation efficiency.
- 🛡️ **Unified Exception Handling**: Comprehensive error handling and retry mechanism.
- 📊 **Detailed Logs**: Structured logging for easy debugging.
- 🐳 **Docker Support**: Containerized deployment, ready to use out of the box.
- ⚙️ **Log Level Control**: Dynamically adjust log output level through configuration files.

## ⚠ Risk Warning

- This project is for research and educational purposes only. It does not accept any financial donations or transactions!
- For personal use and research only. Avoid putting pressure on the official servers. Abuse may result in account bans or legal action.
- For personal use and research only. Avoid putting pressure on the official servers. Abuse may result in account bans or legal action.
- For personal use and research only. Avoid putting pressure on the official servers. Abuse may result in account bans or legal action.

## ✨ New Feature Highlights

### 📐 `ratio` and `resolution` Parameter Support

Image dimensions are now controlled by the `ratio` and `resolution` parameters, giving you more flexibility. The default `resolution` is set to `2k`.

```bash
curl -X POST http://localhost:5100/v1/images/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_SESSION_ID" \
  -d \
    "{\"model\": \"jimeng-4.5\", \"prompt\": \"A beautiful girl, film-like feel\", \"ratio\": \"4:3\", \"resolution\": \"2k\"}"
```

**Supported resolutions**: `1k`, `2k`, `4k`

**Supported ratios**: `1:1`, `4:3`, `3:4`, `16:9`, `9:16`, `3:2`, `2:3`, `21:9`

## 🚀 Quick Start

### Getting `sessionid`
- Getting your `sessionid` works the same way on both the China site (Jimeng) and international sites (Dreamina) — see the screenshot below.
> **Note 1**: The API endpoints are the same for the China site and international sites, but use different prefixes:
> - **China site**: Use the `sessionid` directly, e.g., `Bearer your_session_id`
> - **US site**: Add **us-** prefix, e.g., `Bearer us-your_session_id`
> - **Hong Kong site**: Add **hk-** prefix, e.g., `Bearer hk-your_session_id`
> - **Japan site**: Add **jp-** prefix, e.g., `Bearer jp-your_session_id`
> - **Singapore site**: Add **sg-** prefix, e.g., `Bearer sg-your_session_id`
>
> **Note 2**: Supports binding proxies (HTTP/SOCKS5, etc.) in the Token, see [Token Bound Proxy Feature](#token-bound-proxy-feature-new) for details.
>
> **Note 3**: The China site and international sites now support both *text-to-image* and *image-to-image*. The nanobanana and nanobananapro models are available on international sites.
>
> **Note 4**: Resolution rules when using the nanobanana model on international sites:
> - **US site (us-)**: Images are fixed at **1024x1024** with **2k** resolution, ignoring user-provided ratio and resolution parameters
> - **Hong Kong/Japan/Singapore sites (hk-/jp-/sg-)**: Fixed **1k** resolution, but supports custom `ratio` values (e.g., 16:9, 4:3, etc.)

![](get_sessionid.png)

### Environment Requirements

- Node.js 18+
- npm or yarn
- Docker (optional)

### Installation and Deployment

#### Method 1: Pull and Update the Docker Image (Recommended)

**Pull command**
```bash
docker run -d \
  --name jimeng-api \
  -p 5100:5100 \
  --restart unless-stopped \
  ghcr.io/icysaintdx/jimeng-api:latest
```

**Update command**
```bash
docker run --rm \
  -v /var/run/docker.sock:/var/run/docker.sock \
  containrrr/watchtower \
  --run-once jimeng-api
```

#### Method 2: Direct Run

```bash
# Clone the project
git clone <repository-url>
cd jimeng-api

# Install dependencies
npm install

# Build files
npm run build

# Start the service
npm run dev
```

#### Method 3: Docker Deployment (recommended)

##### 🚀 Quick Start
```bash
# Using docker-compose
docker-compose up -d

# Or build and run manually
docker build -t jimeng-api .

docker run -d \
  --name jimeng-api \
  -p 5100:5100 \
  --restart unless-stopped \
  jimeng-api
```

##### 🔧 Common Commands
```bash
# Rebuild and start
docker-compose up -d --build

# View service logs
docker logs jimeng-api

# Stop service
docker-compose down

# Enter container for debugging
docker exec -it jimeng-api sh
```

##### 📊 Docker Image Features
- ✅ **Multi-stage build**: Optimized image size (170MB)
- ✅ **Non-root user**: Enhanced security (user:jimeng,)
- ✅ **Health check**: Automatic service status monitoring
- ✅ **Unified port**: Uses port 5100 both inside and outside the container
- ✅ **Log management**: Structured log output

### Configuration

#### `configs/dev/service.yml`
```yaml
name: jimeng-api
route: src/api/routes/index.ts
port: 5100
```

#### `configs/dev/system.yml`
```yaml
requestLog: true
debug: false
log_level: info # Log levels: error, warning, info (default), debug
```

## 🖥️ Management Dashboard

A built-in web admin (backed by SQLite) is served at the root path. After the service starts, open `http://localhost:5100/` in your browser.

- **First-time setup**: On first visit you will be prompted to create an admin account (username + password).
- **Account Management**: Add / check / delete Jimeng accounts (sessionid), with automatic region-prefix handling (us-/hk-/jp-/sg-).
- **API Key Management**: Generate, enable/disable, and delete API Keys.
- **Statistics**: View call counts and per-key usage.
- **Real-time Logs**: Inspect and clear runtime logs by level.
- **Media Library**: Browse generated images and videos with pagination.

> The dashboard data (admin credentials, sessions, API keys) is stored in the local `data/` directory, which is excluded from version control.

## 🤖 Claude Code Skill

This project includes a dedicated Claude Code Skill for quick image generation using the Jimeng API directly within Claude Code conversations.

### Features

- 🎯 **Quick Generation**: Use Jimeng API to generate images directly in conversations
- 📁 **Auto-Save**: Generated images are automatically saved to the project's `/pic` directory
- 🔄 **Format Conversion**: Automatic WebP to PNG conversion
- 🎨 **Dual Modes**: Supports both text-to-image and image-to-image generation
- ⚙️ **Configurable**: Customizable ratio, resolution, model parameters, and more

### Installation

1. **Ensure the jimeng-api service is running**:
```bash
# Start the service with Docker
docker-compose up -d
# or
docker run -d --name jimeng-api -p 5100:5100 ghcr.io/icysaintdx/jimeng-api:latest
```

2. **Copy the skill to Claude Code's skills directory**:
```bash
# Copy to user-level global skills directory
cp -r jimeng-api ~/.claude/skills/

# Or copy to project-level skills directory
cp -r jimeng-api ./.claude/skills/
```

3. **Install Python dependencies**:
```bash
pip install requests Pillow
```

### Usage Example

In Claude Code, simply use natural language:

```
User: "my sessionid is xxxxx，Generate a 2K 16:9 image of a futuristic city at sunset using Jimeng"

Claude: [Automatically invokes the skill, generates images, and saves to /pic directory]
```

For more details, see `jimeng-api/Skill.md`.

## 📖 API Documentation

### Text-to-Image

**POST** `/v1/images/generations`

**Request Parameters**:
- `model` (string, optional): The name of the model to use. Defaults to `jimeng-4.5` on all sites (China/US/HK/JP/SG).
- `prompt` (string): The text description of the image.
- `ratio` (string, optional): The aspect ratio of the image, defaults to `"1:1"`. Supported ratios: `1:1`, `4:3`, `3:4`, `16:9`, `9:16`, `3:2`, `2:3`, `21:9`. **Note**: When `intelligent_ratio` is `true`, this parameter will be ignored and the system will automatically infer the optimal ratio from the prompt.
- `resolution` (string, optional): The resolution level, defaults to `"2k"`. Supported resolutions: `1k`, `2k`, `4k`.
- `intelligent_ratio` (boolean, optional): Whether to enable intelligent ratio, defaults to `false`. **⚠️ This parameter only works for the jimeng-4.0/jimeng-4.1/jimeng-4.5/jimeng-4.6/jimeng-5.0 model; other models will ignore it.** When enabled, the system automatically infers the optimal image ratio from the prompt (e.g., "portrait" → 9:16, "landscape" → 16:9).
- `negative_prompt` (string, optional): Negative prompt.
- `sample_strength` (number, optional): Sampling strength (0.0-1.0).
- `response_format` (string, optional): Response format ("url"(default) or "b64_json").

```bash
# Default parameters (ratio: "1:1", resolution: "2k")
curl -X POST http://localhost:5100/v1/images/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_SESSION_ID" \
  -d \
    "{\"model\": \"jimeng-4.5\", \"prompt\": \"A cute little cat\"}"

# Example using 4K resolution
curl -X POST http://localhost:5100/v1/images/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_SESSION_ID" \
  -d \
    "{\"model\": \"jimeng-4.5\", \"prompt\": \"Magnificent landscape, ultra-high resolution\", \"ratio\": \"16:9\", \"resolution\": \"4k\"}"

# Example using intelligent ratio (system will infer 9:16 from "portrait")
curl -X POST http://localhost:5100/v1/images/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_SESSION_ID" \
  -d \
    "{\"model\": \"jimeng-4.5\", \"prompt\": \"A running lion, portrait orientation\", \"resolution\": \"2k\", \"intelligent_ratio\": true}"
```

**Supported Models**:
- `nanobananapro`: International sites only, supports `ratio` and `resolution`.
- `nanobanana`: International sites only.
- `jimeng-5.0`: China and Asia international sites (HK/JP/SG).
- `jimeng-4.6`: China and Asia international sites (HK/JP/SG).
- `jimeng-4.5`: Works on all sites, supports all 2k/4k ratios and intelligent_ratio. **(Default for all sites)**
- `jimeng-4.1`: Works on all sites, supports all 2k/4k ratios and intelligent_ratio.
- `jimeng-4.0`: Works on all sites.
- `jimeng-3.1`: China site only.
- `jimeng-3.0`: Works on all sites.

**Supported Ratios and Corresponding Resolutions**:
| resolution | ratio | Resolution |
|---|---|---|
| `1k` | `1:1` | 1024×1024 |
| | `4:3` | 768×1024 |
| | `3:4` | 1024×768 |
| | `16:9` | 1024×576 |
| | `9:16` | 576×1024 |
| | `3:2` | 1024×682 |
| | `2:3` | 682×1024 |
| | `21:9` | 1195×512 |
| `2k` (default) | `1:1` | 2048×2048 |
| | `4:3` | 2304×1728 |
| | `3:4` | 1728×2304 |
| | `16:9` | 2560×1440 |
| | `9:16` | 1440×2560 |
| | `3:2` | 2496×1664 |
| | `2:3` | 1664×2496 |
| | `21:9` | 3024×1296 |
| `4k` | `1:1` | 4096×4096 |
| | `4:3` | 4608×3456 |
| | `3:4` | 3456×4608 |
| | `16:9` | 5120×2880 |
| | `9:16` | 2880×5120 |
| | `3:2` | 4992×3328 |
| | `2:3` | 3328×4992 |
| | `21:9` | 6048×2592 |

### Image-to-Image

**POST** `/v1/images/compositions`

Generate a new image based on one or more input images, combined with a text prompt. Supports creative modes like image blending, style transfer, and content synthesis.

```bash
# International site image-to-image example (local file upload)
# US site uses "us-YOUR_SESSION_ID"
# Hong Kong site uses "hk-YOUR_SESSION_ID"
# Japan site uses "jp-YOUR_SESSION_ID"
curl -X POST http://localhost:5100/v1/images/compositions \
  -H "Authorization: Bearer us-YOUR_SESSION_ID" \
  -F "prompt=A cute cat, anime style" \
  -F "model=jimeng-4.5" \
  -F "images=@/path/to/your/local/cat.jpg"
```

**Request Parameters**:
- `model` (string, optional): The name of the model to use. Defaults to `jimeng-4.5` on all sites (China/US/HK/JP/SG).
- `prompt` (string): Text description of the image to guide the generation.
- `images` (array): An array of input images.
- `ratio` (string, optional): The aspect ratio of the image, defaults to `"1:1"`. Supported ratios: `1:1`, `4:3`, `3:4`, `16:9`, `9:16`, `3:2`, `2:3`, `21:9`.
- `resolution` (string, optional): The resolution level, defaults to `"2k"`. Supported resolutions: `1k`, `2k`, `4k`.
- `intelligent_ratio` (boolean, optional): Whether to enable intelligent ratio, defaults to `false`. **⚠️ This parameter only works for the jimeng-4.0/jimeng-4.1/jimeng-4.5 model; other models will ignore it.** When enabled, the system automatically adjusts the output ratio based on the prompt and input images.
- `negative_prompt` (string, optional): Negative prompt.
- `sample_strength` (number, optional): Sampling strength (0.0-1.0).
- `response_format` (string, optional): Response format ("url"(default) or "b64_json").

**Limits**:
- Number of input images: 1-10
- Supported image formats: Common formats (JPG, PNG, WebP, etc.).
- Image size limit: Recommended not to exceed 100MB per image.
- Generation time: Typically 30 seconds to 5 minutes; complex compositions may take longer.

**Usage Examples**:

```bash
# Example 1: URL image style transfer (using application/json)
curl -X POST http://localhost:5100/v1/images/compositions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_SESSION_ID" \
  -d \
    "{\"model\": \"jimeng-4.5\", \"prompt\": \"Convert this photo into an oil painting style, with vibrant colors and distinct brushstrokes\", \"images\": [\"https://example.com/photo.jpg\"], \"ratio\": \"1:1\", \"resolution\": \"2k\", \"sample_strength\": 0.7}"

# Example 2: Local single file upload (using multipart/form-data)
curl -X POST http://localhost:5100/v1/images/compositions \
  -H "Authorization: Bearer YOUR_SESSION_ID" \
  -F "prompt=A cute cat, anime style" \
  -F "model=jimeng-4.5" \
  -F "ratio=1:1" \
  -F "resolution=1k" \
  -F "images=@/path/to/your/local/cat.jpg"

# Example 3: Local multiple file upload (using multipart/form-data)
curl -X POST http://localhost:5100/v1/images/compositions \
  -H "Authorization: Bearer YOUR_SESSION_ID" \
  -F "prompt=Merge these two images" \
  -F "model=jimeng-4.5" \
  -F "images=@/path/to/your/image1.jpg" \
  -F "images=@/path/to/your/image2.png"
```

**Successful Response Example** (applies to all examples above):
```json
{
  "created": 1703123456,
  "data": [
    {
      "url": "https://p3-sign.toutiaoimg.com/tos-cn-i-tb4s082cfz/abc123.webp"
    }
  ],
  "input_images": 1,
  "composition_type": "multi_image_synthesis"
}
```

#### ❓ **FAQ & Solutions**

**Q: What if my upload fails?**
A: Make sure the image URL is reachable, the format is supported, and the file size is under 100MB.

**Q: What if generation takes too long?**
A: Complex multi-image compositions can take longer. If it still isn't done after 10 minutes, try resubmitting the request.

**Q: How to improve composition quality?**
A:
- Start with high-quality input images.
- Write clear, detailed prompts.
- Tune the `sample_strength` parameter.
- Avoid mixing too many conflicting styles.

**Q: What image formats are supported?**
A: Common formats (JPG, PNG, WebP, GIF) work. JPG or PNG is recommended.

**Q: Can I use local images?**
A: Yes—direct local file upload is supported. See the "Local single file upload" example above. You can also keep using image URLs.

### Video Generation

**POST** `/v1/videos/generations`

Generate a video from a text prompt (Text-to-Video) or from start/end frame images (Image-to-Video). Supports four generation modes:

1. **Text-to-Video**: Pure text prompt without any images
2. **Image-to-Video**: Single image as the first frame
3. **First-Last Frame**: Two images as the first and last frames
4. **Omni Reference** (New): Mixed image + video inputs as reference materials, with `@field_name` references in the prompt to describe each material's role. Only supported by `jimeng-video-seedance-2.0` and `jimeng-video-seedance-2.0-fast`.

> **Mode Detection**: The system automatically determines the generation mode based on the presence of images:
> - **No images** → Text-to-Video mode
> - **1 image** → Image-to-Video mode (only first_frame_image is provided)
> - **2 images** → First-Last Frame mode (both first_frame_image and end_frame_image are provided)
> - **`functionMode=omni_reference`** → Omni Reference mode (requires explicit parameter)

**Request Parameters**:
- `model` (string): The name of the video model to use.
- `prompt` (string): The text description of the video content.
- `ratio` (string, optional): Video aspect ratio, defaults to `"1:1"`. Supported ratios: `1:1`, `4:3`, `3:4`, `16:9`, `9:16`, `21:9`. **Note**: In image-to-video mode (when images are provided), this parameter will be ignored, and the video aspect ratio will be determined by the input image's actual ratio.
- `resolution` (string, optional): Video resolution, defaults to `"720p"`. Supported resolutions: `720p`, `1080p`. **Note**: Only `jimeng-video-3.0` and `jimeng-video-3.0-fast` support this parameter; other models ignore it.
- `duration` (number, optional): Video duration in seconds. Supported values vary by model:
  - `jimeng-video-veo3` / `jimeng-video-veo3.1`: `8` (fixed)
  - `jimeng-video-sora2`: `4` (default), `8`, `12`
  - `jimeng-video-seedance-2.0` / `jimeng-video-seedance-2.0-fast`: `4`~`15` (any integer second, default `5`)
  - `jimeng-video-3.5-pro`: `5` (default), `10`, `12`
  - Other models: `5` (default), `10`
- `file_paths` (array, optional): An array of image URLs to specify the **start frame** (1st element) and **end frame** (2nd element) of the video.
- `[file]` (file, optional): Local image files uploaded via `multipart/form-data` (up to 2) to specify the **start frame** and **end frame**. The field name can be arbitrary, e.g., `image1`.
- `functionMode` (string, optional): Generation mode. Defaults to `"first_last_frames"`. Supported values:
  - `"first_last_frames"` (default): Standard mode, auto-detects text-to-video / image-to-video / first-last-frame based on image count.
  - `"omni_reference"`: Omni Reference mode. Requires `jimeng-video-seedance-2.0` or `jimeng-video-seedance-2.0-fast` model. Upload files with specific field names: `image_file_1` ~ `image_file_9` (images), `video_file_1` ~ `video_file_3` (videos). Both local files and URLs are supported. Use `@field_name` in the prompt to reference materials.
- `response_format` (string, optional): Response format, supports `url` (default) or `b64_json`.

> **Image Input Description**:
> - You can provide input images via `file_paths` (URL array) or by directly uploading files.
> - If both methods are provided, the system will **prioritize the locally uploaded files**.
> - Up to 2 images are supported, the 1st as the start frame, the 2nd as the end frame.
> - **Important**: Once image input is provided (image-to-video or first-last frame video), the `ratio` parameter will be ignored, and the video aspect ratio will be determined by the input image's actual ratio. The `resolution` parameter remains effective.

> **Omni Reference Mode** (New):
> - Requires `functionMode=omni_reference` and `model=jimeng-video-seedance-2.0`.
> - **Material Limits**:
>   - Up to **9 images** (`image_file_1` ~ `image_file_9`)
>   - Up to **3 videos** (`video_file_1` ~ `video_file_3`)
>   - Total materials (images + videos) ≤ **12**
>   - Total video duration ≤ **15 seconds**
> - **Image inputs** support three methods (priority from high to low):
>   1. **Local file upload**: `multipart/form-data` with field names `image_file_1` ~ `image_file_9` (e.g., curl `-F "image_file_1=@local.jpg"`)
>   2. **URL in form field**: Same field names but with a URL string instead of a file (e.g., curl `-F "image_file_1=https://..."`, no `@` prefix). The server downloads the image first, then uploads it.
>   3. **`file_paths`/`filePaths` array**: URL array in JSON body, mapped to `image_file_1`/`image_file_2`... slots in order.
> - All three methods can be **mixed freely** — each slot is filled by the highest-priority source available.
> - **Video input** supports two methods (priority from high to low):
>   1. **Local file upload**: `multipart/form-data` with field name `video_file_1` ~ `video_file_3` (e.g., curl `-F "video_file_1=@local.mp4"`)
>   2. **URL in form field**: Same field name but with a URL string instead of a file (e.g., curl `-F "video_file_1=https://..."`, no `@` prefix). The server downloads the video first, then uploads it.
> - At least 1 material (image or video) is required, up to 12 files total.
> - In the `prompt`, use `@field_name` (e.g., `@image_file_1`, `@video_file_1`) or `@original_filename` to reference materials and describe their roles.
> - **Note**: When using curl `-F`, the `@` symbol in `prompt` values is interpreted as a file reference. Use `--form-string` for the prompt field instead.
> - Example prompt: `"@image_file_1 as first frame, @image_file_2 as last frame, mimic motion from @video_file_1"`

**Supported Video Models**:
- `jimeng-video-seedance-2.0` - Seedance 2.0, China site only, supports 4~15s duration, supports Omni Reference mode **(Latest)**
- `jimeng-video-seedance-2.0-fast` - Seedance 2.0 Fast, China site only, supports 4~15s duration, supports Omni Reference mode, faster generation speed
- `jimeng-video-3.5-pro` - Professional Edition v3.5, works on all sites **(Default)**
- `jimeng-video-veo3` - Veo3 model, Asia international sites only (HK/JP/SG), fixed 8s duration
- `jimeng-video-veo3.1` - Veo3.1 model, Asia international sites only (HK/JP/SG), fixed 8s duration
- `jimeng-video-sora2` - Sora2 model, Asia international sites only (HK/JP/SG)
- `jimeng-video-3.0-pro` - Professional Edition, China and Asia international sites (HK/JP/SG)
- `jimeng-video-3.0` - Standard Edition, works on all sites
- `jimeng-video-3.0-fast` - Fast Edition, China and Asia international sites (HK/JP/SG)
- `jimeng-video-2.0-pro` - Professional Edition v2, China and Asia international sites (HK/JP/SG)
- `jimeng-video-2.0` - Standard Edition v2, China and Asia international sites (HK/JP/SG)

> **Note**: US site only supports `jimeng-video-3.5-pro` and `jimeng-video-3.0` models.

**Usage Examples**:

```bash
# Example 1: Text-to-Video (0 images) - Pure text generation
curl -X POST http://localhost:5100/v1/videos/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_SESSION_ID" \
  -d \
    "{\"model\": \"jimeng-video-3.0\", \"prompt\": \"A lion running on the grassland\", \"ratio\": \"16:9\", \"resolution\": \"1080p\", \"duration\": 10}"

# Example 2: Image-to-Video (1 image) - Single image as first frame
curl -X POST http://localhost:5100/v1/videos/generations \
  -H "Authorization: Bearer YOUR_SESSION_ID" \
  -F "prompt=A man is talking" \
  -F "model=jimeng-video-3.0" \
  -F "ratio=9:16" \
  -F "duration=5" \
  -F "image_file_1=@/path/to/your/first-frame.png"

# Example 3: First-Last Frame (2 images) - Two images as first and last frames
curl -X POST http://localhost:5100/v1/videos/generations \
  -H "Authorization: Bearer YOUR_SESSION_ID" \
  -F "prompt=Smooth transition between scenes" \
  -F "model=jimeng-video-3.0" \
  -F "ratio=16:9" \
  -F "duration=10" \
  -F "image_file_1=@/path/to/first-frame.png" \
  -F "image_file_2=@/path/to/last-frame.png"

# Example 4: Image-to-Video with URL image
curl -X POST http://localhost:5100/v1/videos/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_SESSION_ID" \
  -d \
    "{\"model\": \"jimeng-video-3.0\", \"prompt\": \"A woman dancing in a garden\", \"ratio\": \"4:3\", \"duration\": 10, \"filePaths\": [\"https://example.com/your-image.jpg\"]}"

# Example 5: Omni Reference mode - all local files
# Requires jimeng-video-seedance-2.0 model
# Note: Use --form-string for prompt containing @ references (curl -F interprets @ as file)
curl -X POST http://localhost:5100/v1/videos/generations \
  -H "Authorization: Bearer YOUR_SESSION_ID" \
  --form-string "prompt=@image_file_1 as first frame, @image_file_2 as last frame, mimic motion from @video_file" \
  -F "model=jimeng-video-seedance-2.0" \
  -F "functionMode=omni_reference" \
  -F "ratio=16:9" \
  -F "duration=5" \
  -F "image_file_1=@/path/to/first.png" \
  -F "image_file_2=@/path/to/second.png" \
  -F "video_file=@/path/to/reference-video.mp4"

# Example 6: Omni Reference mode - mix URL images + local video
# image_file_1/image_file_2 use URLs (no @ prefix), video_file uses local file (with @ prefix)
curl -X POST http://localhost:5100/v1/videos/generations \
  -H "Authorization: Bearer YOUR_SESSION_ID" \
  --form-string "prompt=@image_file_1 as first frame, @image_file_2 as last frame, mimic motion from @video_file" \
  -F "model=jimeng-video-seedance-2.0" \
  -F "functionMode=omni_reference" \
  -F "ratio=16:9" \
  -F "duration=5" \
  -F "image_file_1=https://example.com/first.jpg" \
  -F "image_file_2=https://example.com/second.jpg" \
  -F "video_file=@/path/to/reference-video.mp4"

# Example 7: Omni Reference mode - all materials via URL (no local files needed)
# image_file_1/image_file_2/video_file all use URLs (no @ prefix)
curl -X POST http://localhost:5100/v1/videos/generations \
  -H "Authorization: Bearer YOUR_SESSION_ID" \
  --form-string "prompt=@image_file_1 as first frame, @image_file_2 as last frame, mimic motion from @video_file" \
  -F "model=jimeng-video-seedance-2.0" \
  -F "functionMode=omni_reference" \
  -F "ratio=16:9" \
  -F "duration=5" \
  -F "image_file_1=https://example.com/first.jpg" \
  -F "image_file_2=https://example.com/second.jpg" \
  -F "video_file=https://example.com/reference-video.mp4"

```

### Token API

#### Token Bound Proxy Feature (New)

**Description**: Users can embed a proxy URL in the token to solve issues where IP restrictions lead to 0 credit points during check-in. Each account can be bound to an independent proxy.

**Token Format**:
```
[ProxyURL@][RegionPrefix-]session_id

The proxy prefix is at the outermost layer, and the region prefix follows the session_id.
```

**Supported Proxy Protocols**:
- HTTP Proxy: `http://host:port`
- HTTPS Proxy: `https://host:port`
- SOCKS4 Proxy: `socks4://host:port`
- SOCKS5 Proxy: `socks5://host:port`
- Authenticated Proxy: `http://user:pass@host:port`

**Full Examples**:
| Scenario | Token Format |
|------|-----------|
| China site, no proxy | `session_id_xxx` |
| US site, no proxy | `us-session_id_xxx` |
| HK site, no proxy | `hk-session_id_xxx` |
| China site + SOCKS5 Proxy | `socks5://127.0.0.1:1080@session_id_xxx` |
| US site + HTTP Proxy | `http://127.0.0.1:7890@us-session_id_xxx` |
| HK site + Auth Proxy | `http://user:pass@proxy.com:8080@hk-session_id_xxx` |

**API Call Examples**:
```bash
# Single token with proxy
curl -X POST http://localhost:5100/v1/images/generations \
  -H "Authorization: Bearer socks5://127.0.0.1:1080@us-session_id" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "a cat", "model": "jimeng-3.0"}'

# Multiple tokens, some with proxy
curl -X POST http://localhost:5100/token/receive \
  -H "Authorization: Bearer socks5://1.2.3.4:1080@us-token1,http://5.6.7.8:8080@hk-token2,token3"
```

**Backward Compatibility**: The token format without a proxy is fully compatible and requires no changes.

#### Check Token Status

**POST** `/token/check`

Check if a token is valid and active.

**Request Parameters**:
- `token` (string): The session token to check

**Response Format**:
```json
{
  "live": true
}
```

#### Get Credit Points

**POST** `/token/points`

Get the current credit balance for one or more tokens.

**Request Headers**:
- `Authorization`: Bearer token(s), multiple tokens separated by commas

**Response Format**:
```json
[
  {
    "token": "your_token",
    "points": {
      "giftCredit": 10,
      "purchaseCredit": 0,
      "vipCredit": 0,
      "totalCredit": 10
    }
  }
]
```

#### Receive Daily Credits

**POST** `/token/receive`

Manually trigger daily credit collection (check-in). Attempts to claim credits and returns the latest credit information regardless of claim success.

**Request Headers**:
- `Authorization`: Bearer token(s), multiple tokens separated by commas

**Response Format**:
```json
[
  {
    "token": "your_token",
    "credits": {
      "giftCredit": 10,
      "purchaseCredit": 0,
      "vipCredit": 0,
      "totalCredit": 10
    },
    "received": true,
    "error": "optional error message"
  }
]
```

**Response Fields**:
- `token` (string): The token that was processed
- `credits` (object): Current credit balance after operation
- `received` (boolean): Whether credits were successfully claimed (`true` if claimed, `false` if already had credits or claim failed)
- `error` (string, optional): Error message if claim failed

**Usage Example**:
```bash
# Single token
curl -X POST http://localhost:5100/token/receive \
  -H "Authorization: Bearer YOUR_SESSION_ID"

# Multiple tokens
curl -X POST http://localhost:5100/token/receive \
  -H "Authorization: Bearer TOKEN1,TOKEN2,TOKEN3"
```

## 🔍 API Response Format

### Image Generation Response
```json
{
  "created": 1759058768,
  "data": [
    {
      "url": "https://example.com/image1.jpg"
    },
    {
      "url": "https://example.com/image2.jpg"
    }
  ]
}
```

## 🏗️ Project Architecture

```
jimeng-api/
├── src/
│   ├── api/
│   │   ├── builders/             # Request builders
│   │   │   └── payload-builder.ts  # API request payload builder
│   │   ├── controllers/          # Controller layer
│   │   │   ├── core.ts           # Core functions (network requests, file handling)
│   │   │   ├── images.ts         # Image generation logic
│   │   │   └── videos.ts         # Video generation logic
│   │   ├── routes/               # Route definitions
│   │   │   ├── index.ts          # Route entry
│   │   │   ├── images.ts         # Image generation routes
│   │   │   ├── videos.ts         # Video generation routes
│   │   │   ├── token.ts          # Token management routes
│   │   │   ├── models.ts         # Model list routes
│   │   │   └── ping.ts           # Health check routes
│   │   └── consts/               # Constant definitions
│   │       ├── common.ts         # Common constants
│   │       ├── dreamina.ts       # Dreamina site constants
│   │       └── exceptions.ts     # Exception constants
│   ├── lib/                      # Core library
│   │   ├── configs/              # Configuration loading
│   │   │   ├── service-config.ts # Service configuration
│   │   │   └── system-config.ts  # System configuration
│   │   ├── consts/               # Constants
│   │   ├── exceptions/           # Exception classes
│   │   │   ├── Exception.ts      # Base exception
│   │   │   └── APIException.ts   # API exception
│   │   ├── request/              # Request handling
│   │   │   └── Request.ts        # Request wrapper
│   │   ├── response/             # Response handling
│   │   │   ├── Response.ts       # Response wrapper
│   │   │   ├── Body.ts           # Response body base
│   │   │   ├── SuccessfulBody.ts # Success response body
│   │   │   └── FailureBody.ts    # Failure response body
│   │   ├── config.ts             # Configuration center
│   │   ├── server.ts             # Server core
│   │   ├── logger.ts             # Logger
│   │   ├── error-handler.ts      # Unified error handling
│   │   ├── smart-poller.ts       # Smart poller
│   │   ├── aws-signature.ts      # AWS signature
│   │   ├── environment.ts        # Environment variables
│   │   ├── initialize.ts         # Initialization logic
│   │   ├── http-status-codes.ts  # HTTP status code constants
│   │   ├── image-uploader.ts     # Image upload utility
│   │   ├── image-utils.ts        # Image processing utility
│   │   ├── region-utils.ts       # Region handling utility
│   │   ├── video-uploader.ts     # Video upload utility (VOD)
│   │   └── util.ts               # Common utility functions
│   └── index.ts                  # Entry file
├── configs/                      # Configuration files
├── Dockerfile                    # Docker configuration
└── package.json                  # Project configuration
```

## 🔧 Core Components

### SmartPoller
- Adapts polling interval based on status codes.
- Multiple exit conditions to avoid invalid waiting.
- Detailed progress tracking and logging.

### Unified ErrorHandler
- Categorized error handling (network errors, API errors, timeouts, etc.).
- Automatic retry mechanism.
- User-friendly error messages.

### Safe JSON Parsing
- Automatically fixes common JSON format issues.
- Supports trailing commas and single quotes.
- Detailed parsing error logs.

## ⚙️ Advanced Configuration

### Polling Configuration
```typescript
export const POLLING_CONFIG = {
  MAX_POLL_COUNT: 900,    // Max polling attempts (15 minutes)
  POLL_INTERVAL: 5000,    // Base polling interval (5 second)
  STABLE_ROUNDS: 5,       // Stable rounds
  TIMEOUT_SECONDS: 900    // Timeout (15 minutes)
};
```

### Retry Configuration
```typescript
export const RETRY_CONFIG = {
  MAX_RETRY_COUNT: 3,     // Max retry attempts
  RETRY_DELAY: 5000       // Retry delay (5 seconds)
};
```

## 🐛 Troubleshooting

### Common Issues

1.  **JSON Parsing Error**
    -   Make sure your request body is valid.
    -   The system will automatically fix common format issues.

2.  **Invalid `sessionid`**
    -   Get a fresh `sessionid` from the appropriate site.
    -   Check if the `sessionid` format is correct.

3.  **Generation Timeout**
    -   Image generation: up to 15 minutes max (may queue during peak hours).
    -   Video generation: up to 20 minutes max.
    -   The system will automatically handle timeouts and return an error message.

4.  **Insufficient Credits**
    -   Go to the Jimeng/Dreamina official website to check your credit balance.
    -   The API returns detailed credit info.

## 🙏 References

This project references and builds upon the following open-source projects:

- [jimeng-free-api-all](https://github.com/wwwzhouhui/jimeng-free-api-all) — Reference for the reverse-engineering approach of the Jimeng API.

## 📄 License

GPL v3 License - see the [LICENSE](LICENSE) file for details.

## ⚠️ Disclaimer

This project is for learning and research purposes only. Please comply with relevant service terms and laws. Any consequences arising from the use of this project are the sole responsibility of the user.
