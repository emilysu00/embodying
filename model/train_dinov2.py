"""
Project: Exploration of XAI Assisting Students in Digital Studying
         Through Real-Time Feedback Based on Behavioural Cues

Description:
    Trains an XGBoost classifier using visual feature embeddings
    extracted from a pretrained, frozen DINOv2-Small model.

    Evaluates classification performance using Leave-One-Participant-Out
    Cross-Validation (LOPO-CV) and generates confusion matrices,
    accuracy curves, and multiclass log-loss curves.

    The final classifier is trained on the complete dataset and saved
    for subsequent webcam-based inference.

AI assistance:
    This script was developed with assistance from OpenAI ChatGPT
    (GPT-5.6), with subsequent modifications and testing.
"""
import argparse
from pathlib import Path

import joblib
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from sklearn.metrics import accuracy_score, classification_report, confusion_matrix, f1_score
from sklearn.model_selection import LeaveOneGroupOut
from sklearn.preprocessing import LabelEncoder
from xgboost import XGBClassifier

CLASSES = ['Boredom', 'Concentrated', 'Fatigue', 'Mobile_distraction']
EXTS = {'.jpg', '.jpeg', '.png', '.webp'}
MODEL_NAME = 'vit_small_patch14_dinov2.lvd142m'

#import the data per participant
def index_data(root):
    rows = []
    for cls in CLASSES:
        class_dir = root / cls
        if not class_dir.is_dir() and cls == 'Mobile_distraction':
            class_dir = root / 'Mobile distraction'
        if not class_dir.is_dir():
            raise FileNotFoundError(f'Missing class folder: {class_dir}')
        for participant in sorted(class_dir.iterdir()):
            if not participant.is_dir():
                continue
            for image in sorted(participant.rglob('*')):
                if image.is_file() and image.suffix.lower() in EXTS:
                    rows.append((str(image.resolve()), cls, participant.name.strip().lower()))
    df = pd.DataFrame(rows, columns=['filepath', 'label', 'participant'])
    if df.empty or df.participant.nunique() < 3:
        raise ValueError('Dataset needs images from at least 3 distinct participants.')
    print(pd.crosstab(df.participant, df.label).to_string(), flush=True)
    print('Participants:', sorted(df.participant.unique()), flush=True)
    return df

#model with parameters
def xgb():
    return XGBClassifier(
        objective='multi:softprob', num_class=4,
        n_estimators=250, max_depth=2, learning_rate=0.03,
        min_child_weight=5, subsample=0.8, colsample_bytree=0.8,
        reg_lambda=5, reg_alpha=0.5,
        eval_metric=['mlogloss', 'merror'], tree_method='hist',
        random_state=42, n_jobs=-1,
    )


def path_key(path):
    parts = [p.casefold().replace(' ', '_') for p in str(path).replace('\\', '/').split('/') if p and p != '.']
    known = {c.casefold() for c in CLASSES}
    matches = [i for i, part in enumerate(parts) if part in known]
    if len(matches) != 1:
        raise ValueError(f'Could not identify a unique class in path: {path}')
    return '/'.join(parts[matches[0]:])

#load in previously extracted features and contains logic to prevent repeated extraction
def load_cache(cache, paths):
    with np.load(cache, allow_pickle=False) as z:
        if 'X' not in z or 'paths' not in z:
            raise ValueError('Cache must contain X and paths arrays.')
        X = z['X']
        cached_paths = z['paths']
    if len(X) != len(cached_paths):
        raise ValueError('Cache contains different numbers of paths and feature vectors.')
    cache_keys = [path_key(p) for p in cached_paths]
    wanted_keys = [path_key(p) for p in paths]
    if len(set(cache_keys)) != len(cache_keys) or len(set(wanted_keys)) != len(wanted_keys):
        raise ValueError('Duplicate image identities found in cache or dataset.')
    lookup = {key: i for i, key in enumerate(cache_keys)}
    missing = [key for key in wanted_keys if key not in lookup]
    if missing:
        raise ValueError(f'{len(missing)} dataset images are missing from the cache. Examples: {missing[:5]}')
    aligned = X[[lookup[key] for key in wanted_keys]]
    if aligned.ndim != 2 or not np.isfinite(aligned).all():
        raise ValueError('Aligned DINOv2 feature matrix has invalid shape or nonfinite values.')
    print(f'Loaded {len(aligned)} embeddings; ignored {len(X) - len(aligned)} cached images no longer in dataset.', flush=True)
    return aligned

#plot the required training metrics
def plot_confusion(y, pred, names, filename):
    cm = confusion_matrix(y, pred, labels=np.arange(len(names)))
    norm = cm / np.maximum(cm.sum(axis=1, keepdims=True), 1)
    fig, ax = plt.subplots(figsize=(9, 7))
    im = ax.imshow(norm, cmap='Blues', vmin=0, vmax=1)
    ax.set_xticks(range(len(names)), names, rotation=25, ha='right')
    ax.set_yticks(range(len(names)), names)
    ax.set_xlabel('Predicted')
    ax.set_ylabel('Actual')
    for i in range(len(names)):
        for j in range(len(names)):
            ax.text(j, i, f'{norm[i, j]:.1%}', ha='center', va='center',
                    color='white' if norm[i, j] > .5 else 'black')
    fig.colorbar(im, ax=ax)
    fig.tight_layout()
    fig.savefig(filename, dpi=300)
    plt.close(fig)


def plot_curves(history, out, prefix):
    df = pd.DataFrame(history)
    df.to_csv(out / f'{prefix}_learning_curves.csv', index=False)
    means = df.groupby('round', as_index=False)[
        ['train_mlogloss', 'heldout_mlogloss', 'train_merror', 'heldout_merror']
    ].mean()
    means.to_csv(out / f'{prefix}_mean_curves.csv', index=False)

    fig, ax = plt.subplots(figsize=(9, 5.5))
    ax.plot(means['round'], means['train_mlogloss'], label='Training log-loss', linewidth=2)
    ax.plot(means['round'], means['heldout_mlogloss'], label='Held-out participant log-loss', linewidth=2)
    ax.set_xlabel('Boosting round')
    ax.set_ylabel('Multiclass log-loss')
    ax.set_title('DINOv2 + XGBoost: log-loss (mean over LOPO folds)')
    ax.grid(alpha=.25)
    ax.legend()
    fig.tight_layout()
    fig.savefig(out / f'{prefix}_loss_curve.png', dpi=300)
    plt.close(fig)

    fig, ax = plt.subplots(figsize=(9, 5.5))
    ax.plot(means['round'], 1 - means['train_merror'], label='Training accuracy', linewidth=2)
    ax.plot(means['round'], 1 - means['heldout_merror'], label='Held-out participant accuracy', linewidth=2)
    ax.set_ylim(0, 1)
    ax.set_xlabel('Boosting round')
    ax.set_ylabel('Accuracy')
    ax.set_title('DINOv2 + XGBoost: accuracy (mean over LOPO folds)')
    ax.grid(alpha=.25)
    ax.legend()
    fig.tight_layout()
    fig.savefig(out / f'{prefix}_accuracy_curve.png', dpi=300)
    plt.close(fig)

#Logic for LOPOCV
def evaluate(X, y, groups, names, paths, out, prefix='dinov2_only'):
    cv = LeaveOneGroupOut()
    predictions = np.full(len(y), -1, dtype=int)
    history, participant_rows = [], []
    folds = cv.get_n_splits(groups=groups)
    for fold, (train_ids, test_ids) in enumerate(cv.split(X, y, groups), start=1):
        person = str(groups[test_ids[0]])
        if len(np.unique(y[train_ids])) != len(names):
            raise ValueError(f'Training fold for {person} is missing a class.')
        model = xgb()
        model.fit(X[train_ids], y[train_ids],
                  eval_set=[(X[train_ids], y[train_ids]), (X[test_ids], y[test_ids])],
                  verbose=False)
        metrics = model.evals_result()
        train = metrics['validation_0']
        heldout = metrics['validation_1']
        for i in range(len(train['mlogloss'])):
            history.append({
                'participant': person, 'round': i + 1,
                'train_mlogloss': train['mlogloss'][i],
                'heldout_mlogloss': heldout['mlogloss'][i],
                'train_merror': train['merror'][i],
                'heldout_merror': heldout['merror'][i],
            })
        predictions[test_ids] = model.predict(X[test_ids])
        scores = {
            'participant': person,
            'macro_f1': f1_score(y[test_ids], predictions[test_ids], average='macro', labels=np.arange(len(names)), zero_division=0),
            'accuracy': accuracy_score(y[test_ids], predictions[test_ids]),
            'n': len(test_ids),
        }
        participant_rows.append(scores)
        print(f'Fold {fold}/{folds} {person}: macro-F1={scores["macro_f1"]:.4f}, accuracy={scores["accuracy"]:.4f}', flush=True)

    pooled_f1 = f1_score(y, predictions, average='macro')
    pooled_accuracy = accuracy_score(y, predictions)
    print(f'\n{prefix}: pooled macro-F1={pooled_f1:.4f}, accuracy={pooled_accuracy:.4f}', flush=True)
    print(classification_report(y, predictions, target_names=names, zero_division=0), flush=True)
    pd.DataFrame(participant_rows).to_csv(out / f'{prefix}_participants.csv', index=False)
    pd.DataFrame({
        'filepath': paths,
        'participant': groups,
        'actual': [names[i] for i in y],
        'predicted': [names[i] for i in predictions],
    }).to_csv(out / f'{prefix}_predictions.csv', index=False)
    plot_confusion(y, predictions, names, out / f'{prefix}_confusion_matrix.png')
    plot_curves(history, out, prefix)
    print('Training final classifier on all participants...', flush=True)
    final_model = xgb()
    final_model.fit(X, y)
    joblib.dump({'model': final_model, 'labels': list(names),
                 'features': prefix, 'dinov2_model': MODEL_NAME},
                out / f'{prefix}_model.joblib')
    return {'variant': prefix, 'macro_f1': pooled_f1, 'accuracy': pooled_accuracy}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--data', required=True, type=Path)
    parser.add_argument('--out', default=Path('results_dinov2'), type=Path)
    parser.add_argument('--dinov2-cache', type=Path, default=None)
    parser.add_argument('--batch-size', type=int, default=4)
    parser.add_argument('--device', choices=['auto', 'cpu', 'cuda'], default='auto')
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    df = index_data(args.data)
    paths = df.filepath.tolist()
    cache = args.dinov2_cache or (args.out / 'dinov2_embeddings.npz')
    if cache.is_file():
        X = load_cache(cache, paths)
    elif args.dinov2_cache is not None:
        raise FileNotFoundError(f'DINOv2 cache not found: {cache}')
    else:
        from dinov2_features import extract_embeddings
        print('No existing cache; extracting DINOv2 features (slow on CPU).', flush=True)
        X = extract_embeddings(paths, args.batch_size, args.device)
        np.savez_compressed(cache, X=X, paths=np.asarray(paths))

    encoder = LabelEncoder()
    y = encoder.fit_transform(df.label)
    scores = evaluate(X, y, df.participant.to_numpy(), encoder.classes_, paths,
                      args.out, 'dinov2_only')
    pd.DataFrame([scores]).to_csv(args.out / 'comparison.csv', index=False)
    print('Results saved in:', args.out.resolve(), flush=True)


if __name__ == '__main__':
    main()
