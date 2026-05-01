#testing merge split

l1=[1,3,2,11,4,2,3,433,12,1,11,678]
b=len(l1)//2
l=l1[:b]
r=l1[b:]
result=[]
i=j=0
while i < len(l) and j < len(r):
    if l[i]<r[j]:
        result.append(l[i])
        i=i+1
    else:
        result.append(r[j])
        j=j+1

result.extend(l[i:])
result.extend(r[j:])
print(result)