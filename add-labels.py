from PIL import Image, ImageDraw, ImageFont
import os, subprocess

frames = sorted([f for f in os.listdir("frames") if f.endswith(".png")])

labels = [
    "SECOP reCAPTCHA Solver - Ponytail Edition\n[1/9] Gatekept Page\nContract Notice Management Index\nNo captcha solved yet",
    "SECOP reCAPTCHA Solver - Ponytail Edition\n[2/9] Captcha Index\nNavigating to Google reCAPTCHA page\nEstablishes session, generates mkey",
    "SECOP reCAPTCHA Solver - Ponytail Edition\n[3/9] reCAPTCHA Loaded\nI'm not a robot checkbox visible\nToken must be solved for this mkey",
    "SECOP reCAPTCHA Solver - Ponytail Edition\n[4/9] 2Captcha Farm\nSolved by human worker\nTaking ~30-60 seconds",
    "SECOP reCAPTCHA Solver - Ponytail Edition\n[5/9] Token Received\nToken: 0cAFcWeA4...\nReady to submit to SECOP",
    "SECOP reCAPTCHA Solver - Ponytail Edition\n[6/9] Submitting Token\nToken + mkey -> CaptchaCheck\nSending verification request",
    "SECOP reCAPTCHA Solver - Ponytail Edition\n[7/9] SECOP Verification\nSECOP validates token with Google\nWaiting for response...",
    "SECOP reCAPTCHA Solver - Ponytail Edition\n[8/9] Success!\nGatekept page loaded\nNo errors, no captcha challenge",
    "SECOP reCAPTCHA Solver - Ponytail Edition\n[9/9] Complete\nTotal flow: ~90 seconds\nhttpJson removed, native fetch only"
]

title_font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 28)
body_font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 20)

result_frames = []
for i, frame in enumerate(frames):
    img = Image.open(f"frames/{frame}")
    draw = ImageDraw.Draw(img)
    
    label = labels[i] if i < len(labels) else ""
    lines = label.split("\n")
    y = 20
    for j, line in enumerate(lines):
        if "Ponytail" in line:
            font = title_font
            anchor = "mm"
            alignment = "center"
        else:
            font = body_font
            anchor = "lt"
            alignment = "left"
        
        bbox = draw.textbbox((0, 0), line, font=font)
        lw = bbox[2] - bbox[0]
        lh = bbox[3] - bbox[1]
        
        if alignment == "center":
            x = img.size[0] // 2
        else:
            x = 20
        
        draw.rectangle([x-15, y, x+lw+15, y+lh+10], fill=(0, 0, 0, 180))
        draw.text((x, y), line, fill="white", font=font, anchor=anchor)
        y += lh + 15
    
    out = f"labeled_{i+1}.png"
    img.save(out, "PNG")
    result_frames.append(out)
    print(f"  {frame} -> {out}")

# Create ffmpeg command file
with open("ffmpeg-script.txt", "w") as f:
    for frame in result_frames:
        f.write(f"file '{frame}'\n")

print(f"\nCreated {len(result_frames)} labeled frames + ffmpeg-script.txt")
