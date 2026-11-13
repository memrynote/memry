import json,sys,math
a={v['id']:v for v in json.load(open(sys.argv[1]))['vectors']}
b={v['id']:v for v in json.load(open(sys.argv[2]))['vectors']}
cs=[]
for k in a:
    x,y=a[k]['vector'],b[k]['vector']
    c=sum(p*q for p,q in zip(x,y))/math.sqrt(sum(p*p for p in x)*sum(q*q for q in y))
    cs.append(c); print(f"{k:18s} tok {a[k]['tokens']:>4}/{b[k]['tokens']:<4} cos {c:.6f}")
print(f"min {min(cs):.6f} mean {sum(cs)/len(cs):.6f}")
