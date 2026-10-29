"""
This code was part of project "Exploration of XAI assisting students in digital studying through real-time feedback based on behavioural cues."
With this code the dataset statistics can be summarized.
This code has been addapted from ChatGPT 5.6Sol
"""
from pathlib import Path
import pandas as pd
import matplotlib.pyplot as plt

DATA_DIR = Path("./data")

#Labels
CLASSES = [
    "Boredom",
    "Concentrated",
    "Fatigue",
    "Mobile_distraction"
]

EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}

counts = {}

#count number of files within the class
for class_name in CLASSES:
    class_dir = DATA_DIR / class_name

    counts[class_name] = sum(
        1 for p in class_dir.rglob("*")
        if p.is_file() and p.suffix.lower() in EXTENSIONS
    ) if class_dir.exists() else 0

# Create summary
df = pd.DataFrame({
    "Class": list(counts.keys()),
    "Samples": list(counts.values())
})

print("\nDATASET SUMMARY\n")
print(df.to_string(index=False))
print(f"\nTotal samples: {df['Samples'].sum()}")

# Plot class distribution
fig, ax = plt.subplots(figsize=(9, 5))

bars = ax.bar(df["Class"], df["Samples"])

for bar in bars:
    ax.text(
        bar.get_x() + bar.get_width() / 2,
        bar.get_height() + 20,
        str(int(bar.get_height())),
        ha="center"
    )

ax.set_ylabel("Number of images")
ax.set_xlabel("Behavioural class")
ax.set_title("Dataset Class Distribution")
ax.set_ylim(0, max(df["Samples"]) * 1.15)
plt.tight_layout()

plt.savefig("dataset_class_distribution.png", dpi=300)
plt.show()

# Save table
df.to_csv("dataset_summary.csv", index=False)