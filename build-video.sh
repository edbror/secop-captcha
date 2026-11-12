#!/bin/bash
ffmpeg -y \
  -loop 1 -t 10 -i labeled_1.png \
  -loop 1 -t 10 -i labeled_2.png \
  -loop 1 -t 10 -i labeled_3.png \
  -loop 1 -t 10 -i labeled_4.png \
  -loop 1 -t 10 -i labeled_5.png \
  -loop 1 -t 10 -i labeled_6.png \
  -loop 1 -t 10 -i labeled_7.png \
  -loop 1 -t 10 -i labeled_8.png \
  -loop 1 -t 10 -i labeled_9.png \
  -filter_complex "
    [0:v]scale=1280:720:flags=lanczos[v0];
    [1:v]scale=1280:720:flags=lanczos[v1];
    [2:v]scale=1280:720:flags=lanczos[v2];
    [3:v]scale=1280:720:flags=lanczos[v3];
    [4:v]scale=1280:720:flags=lanczos[v4];
    [5:v]scale=1280:720:flags=lanczos[v5];
    [6:v]scale=1280:720:flags=lanczos[v6];
    [7:v]scale=1280:720:flags=lanczos[v7];
    [8:v]scale=1280:720:flags=lanczos[v8];
    [v0][v1][v2][v3][v4][v5][v6][v7][v8]concat=n=9:v=1:a=0[out]
  " \
  -map "[out]" \
  -c:v libx264 \
  -preset medium \
  -pix_fmt yuv420p \
  -movflags +faststart \
  captcha-solve-complete.mp4
