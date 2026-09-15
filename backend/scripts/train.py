"""Train and export a robust fabric-vs-non-fabric model from ImageFolder data.
Expected layout: data/{train,val,test}/{cotton,polyester,denim,wool,silk,non_fabric}/image.jpg
"""
import argparse, copy, json, random, time
from pathlib import Path
import torch
from torch import nn
from torch.utils.data import DataLoader
from torchvision import datasets, models, transforms

ORDER=["cotton","polyester","denim","wool","silk","non_fabric"]
INPUT_SIZE=224
MEAN=[0.485,0.456,0.406]
STD=[0.229,0.224,0.225]

parser=argparse.ArgumentParser()
parser.add_argument("--data", required=True)
parser.add_argument("--epochs", type=int, default=20)
parser.add_argument("--freeze-epochs", type=int, default=3)
parser.add_argument("--batch-size", type=int, default=32)
parser.add_argument("--lr", type=float, default=2e-4)
parser.add_argument("--seed", type=int, default=42)
parser.add_argument("--patience", type=int, default=6)
parser.add_argument("--output", default="backend/models/fabric_mobilenetv2.pt")
args=parser.parse_args()

torch.manual_seed(args.seed)
random.seed(args.seed)

root=Path(args.data)
required=[root/x for x in ("train","val","test")]
if not all(p.is_dir() for p in required): raise SystemExit("Dataset must contain train, val and test ImageFolder directories.")

train_tf=transforms.Compose([
    transforms.RandomResizedCrop(INPUT_SIZE, scale=(0.65, 1.0)),
    transforms.RandomHorizontalFlip(p=0.5),
    transforms.RandomVerticalFlip(p=0.5),
    transforms.RandomRotation(degrees=20),
    transforms.RandomAffine(degrees=0, translate=(0.08, 0.08), shear=8),
    transforms.RandomPerspective(distortion_scale=0.2, p=0.4),
    transforms.ColorJitter(brightness=0.25, contrast=0.25, saturation=0.20, hue=0.05),
    transforms.ToTensor(),
    transforms.Normalize(MEAN, STD),
])
eval_tf=transforms.Compose([
    transforms.Resize((INPUT_SIZE, INPUT_SIZE)),
    transforms.ToTensor(),
    transforms.Normalize(MEAN, STD),
])

def remap(ds):
    missing=set(ORDER)-set(ds.classes)
    if missing: raise SystemExit(f"Dataset folders must include {ORDER}; missing {sorted(missing)}")
    idx={c:i for i,c in enumerate(ORDER)}
    ds.samples=[(p, idx[ds.classes[y]]) for p,y in ds.samples]
    ds.targets=[y for _,y in ds.samples]
    ds.classes=list(ORDER)
    ds.class_to_idx={c:i for i,c in enumerate(ORDER)}
    return ds

train_ds=remap(datasets.ImageFolder(required[0], train_tf))
val_ds=remap(datasets.ImageFolder(required[1], eval_tf))
test_ds=remap(datasets.ImageFolder(required[2], eval_tf))

pin=torch.cuda.is_available()
train_loader=DataLoader(train_ds, batch_size=args.batch_size, shuffle=True, num_workers=0, pin_memory=pin)
val_loader=DataLoader(val_ds, batch_size=args.batch_size, shuffle=False, num_workers=0, pin_memory=pin)
test_loader=DataLoader(test_ds, batch_size=args.batch_size, shuffle=False, num_workers=0, pin_memory=pin)

# Compute balanced class weights
class_counts = [0] * len(ORDER)
for _, target in train_ds.samples:
    class_counts[target] += 1
total_train = len(train_ds.samples)
weights = [total_train / (len(ORDER) * max(1, count)) for count in class_counts]
class_weights_tensor = torch.tensor(weights, dtype=torch.float32)

device="cuda" if torch.cuda.is_available() else "cpu"
class_weights_tensor = class_weights_tensor.to(device)

model=models.mobilenet_v2(weights=models.MobileNet_V2_Weights.DEFAULT)
model.classifier=nn.Sequential(
    nn.Dropout(p=0.3),
    nn.Linear(model.last_channel, len(ORDER))
)
model.to(device)
for p in model.features.parameters(): p.requires_grad=False

criterion=nn.CrossEntropyLoss(weight=class_weights_tensor, label_smoothing=0.05)
optimizer=torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=args.lr, weight_decay=1e-4)
scheduler=torch.optim.lr_scheduler.ReduceLROnPlateau(optimizer, mode="max", factor=0.5, patience=2)

best_acc=0.0
best_state=copy.deepcopy(model.state_dict())
stalled=0

for epoch in range(args.epochs):
    if epoch==args.freeze_epochs:
        for p in model.features.parameters(): p.requires_grad=True
        optimizer=torch.optim.AdamW(model.parameters(), lr=args.lr*0.5, weight_decay=1e-4)
        scheduler=torch.optim.lr_scheduler.ReduceLROnPlateau(optimizer, mode="max", factor=0.5, patience=2)
    model.train()
    train_loss=0.0; train_good=0; train_n=0
    for x,y in train_loader:
        x=x.to(device, non_blocking=True); y=y.to(device, non_blocking=True)
        optimizer.zero_grad()
        logits=model(x)
        loss=criterion(logits,y)
        loss.backward()
        optimizer.step()
        train_loss+=loss.item()*len(y)
        train_good+=(logits.argmax(1)==y).sum().item()
        train_n+=len(y)
    model.eval()
    val_loss=0.0; val_good=0; val_n=0
    with torch.no_grad():
        for x,y in val_loader:
            x=x.to(device, non_blocking=True); y=y.to(device, non_blocking=True)
            logits=model(x)
            loss=criterion(logits,y)
            val_loss+=loss.item()*len(y)
            val_good+=(logits.argmax(1)==y).sum().item()
            val_n+=len(y)
    val_acc=val_good/max(1,val_n)
    scheduler.step(val_acc)
    print(f"epoch {epoch+1:02d}: train_acc {train_good/max(1,train_n):.4f} train_loss {train_loss/max(1,train_n):.4f} val_acc {val_acc:.4f} val_loss {val_loss/max(1,val_n):.4f}")
    if val_acc>best_acc:
        best_acc=val_acc
        best_state=copy.deepcopy(model.state_dict())
        stalled=0
    else:
        stalled+=1
        if stalled>=args.patience:
            print("early stopping: validation did not improve")
            break

model.load_state_dict(best_state)
model.eval()

def infer_stats(loader):
    good=0; n=0
    confidences=[]; margins=[]
    k=len(ORDER)
    matrix=[[0]*k for _ in range(k)]
    with torch.no_grad():
        for x,y in loader:
            x=x.to(device, non_blocking=True); y=y.to(device, non_blocking=True)
            probs=torch.softmax(model(x), dim=1)
            top_vals, top_idx=torch.topk(probs, k=2, dim=1)
            preds=top_idx[:,0]
            correct=(preds==y)
            good+=correct.sum().item()
            n+=len(y)
            for i in range(len(y)):
                matrix[y[i].item()][preds[i].item()]+=1
                if correct[i]:
                    confidences.append(float(top_vals[i,0].item()))
                    margins.append(float((top_vals[i,0]-top_vals[i,1]).item()))
    return good, n, confidences, margins, matrix

val_good, val_n, val_conf, val_margin, _=infer_stats(val_loader)
test_start=time.perf_counter()
test_good, test_n, _, _, test_matrix=infer_stats(test_loader)
test_seconds=time.perf_counter()-test_start

# Compute per-class Precision, Recall, F1
k=len(ORDER)
per_class_metrics={}
f1_list=[]
for c_idx, c_name in enumerate(ORDER):
    tp = test_matrix[c_idx][c_idx]
    fp = sum(test_matrix[r][c_idx] for r in range(k) if r != c_idx)
    fn = sum(test_matrix[c_idx][col] for col in range(k) if col != c_idx)
    support = sum(test_matrix[c_idx])
    precision = round(tp / max(1, tp + fp), 4)
    recall = round(tp / max(1, tp + fn), 4)
    denom = precision + recall
    f1 = round((2 * precision * recall) / denom, 4) if denom > 0 else 0.0
    f1_list.append(f1)
    per_class_metrics[c_name] = {
        "precision": precision,
        "recall": recall,
        "f1_score": f1,
        "support": support
    }

macro_f1 = round(sum(f1_list) / max(1, len(f1_list)), 4)

if val_conf and val_margin:
    conf_tensor=torch.tensor(val_conf)
    margin_tensor=torch.tensor(val_margin)
    min_confidence=max(0.55, min(0.90, float(torch.quantile(conf_tensor, 0.10).item())))
    min_margin=max(0.10, min(0.40, float(torch.quantile(margin_tensor, 0.10).item())))
else:
    min_confidence=0.70
    min_margin=0.20

out=Path(args.output)
out.parent.mkdir(parents=True,exist_ok=True)
torch.jit.script(model.cpu()).save(str(out))
manifest={
    "architecture":"MobileNetV2 transfer learning",
    "classes":train_ds.classes,
    "input_size":INPUT_SIZE,
    "normalization":{"mean":MEAN,"std":STD},
    "val_images":val_n,
    "val_accuracy":round(val_good/max(1,val_n), 4),
    "test_images":test_n,
    "test_accuracy":round(test_good/max(1,test_n), 4),
    "macro_f1":macro_f1,
    "per_class_metrics":per_class_metrics,
    "confusion_matrix":{
        "classes":ORDER,
        "matrix":test_matrix
    },
    "test_inference_seconds":round(test_seconds, 4),
    "min_confidence":round(min_confidence,4),
    "min_margin":round(min_margin,4),
}
out.with_suffix(".manifest.json").write_text(json.dumps(manifest, indent=2))
print(json.dumps(manifest, indent=2))

