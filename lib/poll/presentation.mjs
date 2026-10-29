const positiveDecimal = value => typeof value === 'string' && /^\d+(\.\d+)?$/.test(value) && /[1-9]/.test(value);
export function resultLabel(round) {
 if(round.status === 'void') return '대결 무효 · 점수 없음';
 const result=round.result;
 if(result?.winner === 'humans' || result?.winner === 'human') return '인간 승리';
 if(result?.winner === 'chimp' || result?.winner === 'monkey') return '침팬지 승리';
 if(round.status === 'settled' && result) return `점수 없음 · ${typeof result.reason==='string' && result.reason ? result.reason : '무승부'}`;
 return '가격 확인 중 · 아직 점수를 부여하지 않아요';
}
export function decimalLabel(value) {
 if(!positiveDecimal(value))return null;
 const [whole,fraction]=value.split('.');
 return whole.replace(/\B(?=(\d{3})+(?!\d))/g,',')+(fraction===undefined?'':'.'+fraction);
}
export function personalVerdictLabel(verdict){return ({win:'적중',loss:'미적중',flat:'보합 · 전적 집계 제외',void:'무효 · 전적 집계 제외'})[verdict]??'가격 확인 중';}
export function openingDetails(round) {
 if(!round || round.status==='upcoming')return null;
 const event=round.openingPrice;
 const final=round.status==='settled'&&round.result?.status==='verified'?round.result:null;
 const price=final?.open ?? event?.price;
 if(!positiveDecimal(price))return null;
 const source=final ?? event;
 return {price,sourceLabel:source.sourceLabel,sourceUrl:source.sourceUrl,observedAt:source.observedAt,sessionDate:round.id.split(':')[1],currency:round.market==='KOSPI'?'KRW':'USD'};
}
