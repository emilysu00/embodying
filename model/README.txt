Webcam classifier for 4 classes of disengagement behaviors during self-study

This project contains a model which classifies four visual classes, Boredom, Concentrated, Fatigue, and Mobile_distraction) of disengagement behaviors during self-studying using webcam images. 

It combines a pretrained, frozen DINOv2-small (ViT-S14) feature extractor with a supervised XGBoost classifier. DINO converts the images into 384-dimensional feature vectors which are then used a input voor the XGBoost classifier. This model has been trained on a limited dataset (n =9) of female participants aged 20-25 of Asian and Caucasian descent.


For this model the requirements are:
-windows computer with a working camera
-python (3.12 environment was used for this project)

This project contains: 
-dinov2_features.py, to extract the features from a dataset
-train_dinov2.py, to train the XGBoost classifier on the features extracted from a dataset and store the model in .joblib file
-webcam_dinov2.py, uses .joblib model for live webcame classifier

How to run this model?
1. create a virtual environment and install all the required dependancies

py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install numpy pandas matplotlib scikit-learn xgboost joblib timm torch torchvision pillow opencv-python
 

2 provide a project with the following structure: 

project/
├── dinov2_features.py                  
├── train_dinov2_with_loss.py          
├── webcam_dinov2.py                   
├── data/                              
│   ├── Boredom/
│   │   ├── participant1/
│   │   └── ...
│   ├── Concentrated/
│   ├── Fatigue/
│   └── Mobile_distraction/
├── results_dinov2/
│   └── dinov2_embeddings.npz          
└── results_dinov2_final_1/
    └── dinov2_only_model.joblib       
*the visualization of the structure above has been generate with the help of OpenAI Chatgpt 5.6 Sol.

3. Run the following command to start the live webcame classifier
python webcam_dinov2.py --model ".\dinov2_only_model.joblib" --camera 0

The webcam window now shows the predicted class, a confidence score, and inference time. To exit the window press Q.

Some useful lines: 
To retrain the XGBoost run the following command:
python -u train_dinov2_with_loss.py --data ".\data" --out ".\results_dinov2_final_1" --dinov2-cache ".\results_dinov2\dinov2_embeddings.npz"

Be aware that a new dataset or extended data set requires new/additional features to be extracted.

The following is done:
1. indexes images by class and participant
2. loads in an aligns previously extracted DINOv2 embeddings from the current dataset.
3. Evaluates XGBoost using Leave One Participant Out Cross Validation(LOPOCV).
4. Saves pooled accuracy, marco-F1, per participants results, a confusion matrix, and training/held-out accuracy and multiclass log los curves.
5. trains a final XGBoost classifier on all available images and saves it as dinov2_only_model.joblib

Limitations:

-This model classifies individual webcam frames, and thus does not learn temporal motion sequences or diagnose psychological states
-A prediction always selects the highest-probability class unless an additional application-level threshold is implemented.
-The LOPOCV for one held out particpant is performed withing the dataset.
-The model, dinov2_only_model.joblib, may suffer from model selection bias. As its parameteres have been tuned based uppon the results of the validation.
