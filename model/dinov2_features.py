"""
Project: Exploration of XAI Assisting Students in Digital Studying
         Through Real-Time Feedback Based on Behavioural Cues.

Description:
    This script uses a pretrained, frozen DINOv2-Small model
    via timm to extract 384-dimensional image embeddings
    from our self-collected dataset.

    The pretrained DINOv2 weights are not modified.
    The extracted embeddings are used to train an XGBoost
    classifier separately.

AI Assistance:
    This code was adapted from code generated with assistance
    from OpenAI ChatGPT (GPT-5.6 Sol).
"""
from pathlib import Path
import numpy as np
from PIL import Image
import timm
import torch
from torch.utils.data import Dataset, DataLoader

MODEL_NAME = 'vit_small_patch14_dinov2.lvd142m'

class ImagePaths(Dataset):
    def __init__(self, paths, transform):
        self.paths = list(paths)
        self.transform = transform
    def __len__(self): return len(self.paths)
    def __getitem__(self, index):
        with Image.open(self.paths[index]) as img:
            return self.transform(img.convert('RGB'))

def extract_embeddings(paths, batch_size=4, device='auto'):
    """Return float32 embeddings in exactly the order of `paths`."""
    if device == 'auto':
        device = 'cuda' if torch.cuda.is_available() else 'cpu'
    print('DINOv2 device:', device, flush=True)
    model = timm.create_model(MODEL_NAME, pretrained=True, num_classes=0)
    model = model.eval().to(device)
    cfg = timm.data.resolve_model_data_config(model)
    transform = timm.data.create_transform(**cfg, is_training=False)
    loader = DataLoader(ImagePaths(paths, transform), batch_size=batch_size,
                        shuffle=False, num_workers=0, pin_memory=(device == 'cuda'))
    result = []
    with torch.inference_mode():
        for i, tensor in enumerate(loader):
            tensor = tensor.to(device, non_blocking=True)
            vec = model(tensor).cpu().numpy().astype(np.float32)
            result.append(vec)
            if (i + 1) % 50 == 0 or (i + 1) == len(loader):
                print(f'Embeddings: {min((i + 1) * batch_size, len(paths))}/{len(paths)}', flush=True)
    return np.concatenate(result, axis=0)
