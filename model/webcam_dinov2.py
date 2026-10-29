"""
Project: Exploration of XAI Assisting Students in Digital Studying
         Through Real-Time Feedback Based on Behavioural Cues.

Description:
    This script performs real-time behavioural classification using
    a webcam and a trained DINOv2-Small + XGBoost model.

    Each webcam frame is preprocessed using the same timm
    transformations applied during training. The pretrained,
    frozen DINOv2-Small model extracts 384-dimensional visual
    features, which are then classified by XGBoost
    into one of four behavioural categories.

AI Assistance:
    This code was adapted from code generated with assistance
    from OpenAI ChatGPT (GPT-5.6 Sol).
"""
import argparse
import time
from collections import deque
from pathlib import Path

import cv2
import joblib
import numpy as np
from PIL import Image
import timm
import torch

from dinov2_features import MODEL_NAME


def main():
    parser = argparse.ArgumentParser(description='Run Embody DINOv2 on a live webcam')
    parser.add_argument('--model', type=Path, default=Path('results_dinov2/dinov2_only_model.joblib'))
    parser.add_argument('--camera', type=int, default=0)
    parser.add_argument('--interval', type=float, default=1.0,
                        help='Minimum seconds between classifications (default: 1)')
    parser.add_argument('--threads', type=int, default=4,
                        help='PyTorch CPU inference threads (default: 4)')
    parser.add_argument('--smooth', type=int, default=3,
                        help='Number of probability predictions to average (default: 3)')
    args = parser.parse_args()
    if args.interval < 0 or args.smooth < 1 or args.threads < 1:
        parser.error('--interval must be >= 0 and --smooth/--threads >= 1')

    if not args.model.is_file():
        raise FileNotFoundError(f'Model not found: {args.model}')

    bundle = joblib.load(args.model)
    if bundle.get('features') != 'dinov2_only':
        raise ValueError(f"Expected a DINOv2-only model, got {bundle.get('features')!r}")
    classifier = bundle['model']
    labels = list(bundle['labels'])
    model_name = bundle.get('dinov2_model', MODEL_NAME)
    if model_name != MODEL_NAME:
        raise ValueError(f'Model backbone mismatch: {model_name} vs {MODEL_NAME}')

    torch.set_num_threads(args.threads)
    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    print(f'DINOv2 inference device: {device} (CPU threads: {args.threads})', flush=True)
    print('Loading pretrained DINOv2 backbone (first run may download weights)...', flush=True)
    vision = timm.create_model(model_name, pretrained=True, num_classes=0).eval().to(device)
    transform = timm.data.create_transform(
        **timm.data.resolve_model_data_config(vision), is_training=False)

    cap = cv2.VideoCapture(args.camera, cv2.CAP_DSHOW)
    if not cap.isOpened():
        cap.release()
        cap = cv2.VideoCapture(args.camera)
    if not cap.isOpened():
        raise RuntimeError(f'Cannot open camera {args.camera}. Try --camera 1.')

    history = deque(maxlen=args.smooth)
    last_prediction = -float('inf')
    latest_label = 'Waiting for first prediction'
    latest_score = 0.0
    last_latency = 0.0
    try:
        print('Press Q to quit. The window may pause during CPU inference.', flush=True)
        while True:
            ok, frame = cap.read()
            if not ok:
                print('Could not read webcam frame.')
                break
            now = time.monotonic()
            if now - last_prediction >= args.interval:
                start = time.perf_counter()
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                inp = transform(Image.fromarray(rgb)).unsqueeze(0).to(device)
                with torch.inference_mode():
                    emb = vision(inp).cpu().numpy().astype(np.float32)
                probs = classifier.predict_proba(emb)[0]
                history.append(probs)
                smoothed = np.mean(np.stack(history), axis=0)
                best = int(np.argmax(smoothed))
                latest_label = labels[best]
                latest_score = float(smoothed[best])
                last_latency = time.perf_counter() - start
                last_prediction = time.monotonic()
                print(f'{latest_label:<22} confidence={latest_score:.2f} latency={last_latency:.2f}s', flush=True)

            cv2.putText(frame, f'{latest_label}: {latest_score:.2f}', (16, 40),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.8, (40, 230, 60), 2)
            cv2.putText(frame, f'Inference: {last_latency:.2f}s / prediction', (16, 75),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.58, (40, 230, 60), 2)
            cv2.imshow('Embody DINOv2 - Q to quit', frame)
            if cv2.waitKey(1) & 0xFF == ord('q'):
                break
    finally:
        cap.release()
        cv2.destroyAllWindows()


if __name__ == '__main__':
    main()
